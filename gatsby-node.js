const crypto = require('crypto');
const _ = require('lodash');

// Helper function for retrying failed requests
const fetchWithRetry = async (url, options = {}, retries = 3, delay = 1000) => {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2); // Exponential backoff
    }
    throw err;
  }
};

// Create a custom content type from Docebo API
exports.sourceNodes = async ({ actions, reporter }, { baseUrl, catalogId, relatedLinks }) => {
  const { createNode } = actions;

  // Get courses by catalog id
  const getCatalogById = async (id, page) => {
    try {
      const data = await fetchWithRetry(`${baseUrl}/learn/v1/catalog/${id}?page=${page}`);
      return data;
    } catch (err) {
      reporter.error(`Docebo: Failed to fetch catalog ${id}: ${err.message}`);
      return null;
    }
  };

  const getCoursesByCatalogId = async (id) => {
    let records = [];
    let keepGoing = true;
    let page = 1;
    reporter.info(`Docebo: Retrieving data for catalog id: ${id}`);
    const activity = reporter.activityTimer(`Docebo: Records retrieved for catalog id: ${id}`);
    activity.start();
    while (keepGoing) {
      const res = await getCatalogById(id, page);
      if (!res) {
        keepGoing = false;
        activity.end();
        return records;
      }
      records = [...records, ...res.data.items];
      page = res.data.current_page + 1;

      if (!res.data.has_more_data) {
        keepGoing = false;
        reporter.info(`Docebo: Retrieved ${records.length} records for catalog id: ${id}`);
        activity.end();
        return records;
      }
    }
  };

  // Combine all catalogs
  let catalogs = [];
  for (let i = 0; i < catalogId?.length; i++) {
    catalogs.push(getCoursesByCatalogId(catalogId[i]));
  }
  const result = await Promise.all(catalogs);
  const combinedCatalogs = _.flatten(result).filter(({ access_status }) => access_status === 1);

  if (combinedCatalogs.length === 0) {
    reporter.error('Docebo: No valid courses found in combined catalogs.');
    return;
  }

  // Get individual course data by id
  const courses = await Promise.allSettled(
    combinedCatalogs.map(async ({ item_id }) => {
      try {
        const data = await fetchWithRetry(`${baseUrl}/learn/v1/courses/${item_id}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          redirect: 'follow',
        });
        return data?.data;
      } catch (err) {
        reporter.error(`Docebo: Failed to fetch course ${item_id}: ${err.message}`);
        return null;
      }
    })
  );

  const successfulCourses = courses
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);

  // Get related courses by course id
  const relatedCourses = await Promise.allSettled(
    combinedCatalogs.map(async ({ item_id }) => {
      try {
        const res = await fetchWithRetry(
          `${baseUrl}/learn/v1/courses/${item_id}/by_category?page_size=${relatedLinks}`
        );
        let items = [];
        res.data.items.forEach(item => {
          const course = successfulCourses.find(x => x.id == item.id_course);
          if (course) items.push({ slug: course.slug_name, ...item });
        });
        return { id: item_id, items: items };
      } catch (err) {
        reporter.error(`Docebo: Failed to fetch related courses for ${item_id}: ${err.message}`);
        return null;
      }
    })
  );

  const successfulRelatedCourses = relatedCourses
    .filter(result => result.status === 'fulfilled' && result.value)
    .map(result => result.value);

  // Map into these results and create nodes
  reporter.info(`Docebo: Creating ${successfulCourses.length} Course nodes`);
  const activity = reporter.activityTimer(`Docebo: Course nodes created`);
  activity.start();
  successfulCourses.forEach(course => {
    const related = successfulRelatedCourses.find(x => x?.id == course?.id);
    const courseNode = {
      id: `${course?.id}`,
      parent: `__SOURCE__`,
      internal: {
        type: `CoursePages`,
        contentDigest: crypto
          .createHash(`md5`)
          .update(JSON.stringify(course))
          .digest(`hex`),
      },
      slug: course?.slug_name,
      img: course?.thumbnail,
      uidCourse: course?.uidCourse,
      name: course?.name,
      description: course?.description,
      duration: course?.duration,
      credits: course?.credits,
      additionalFields: course?.additional_fields,
      tree: course?.tree,
      relatedCourses: related?.items
    };
    createNode(courseNode);
  });
  activity.end();
};

// Options schema and testing
exports.pluginOptionsSchema = ({ Joi }) => {
  return Joi.object({
    baseUrl: Joi.string()
      .required()
      .description('Your docebo url')
      .messages({
        'any.required': 'You must provide your docebo url'
      }),
    relatedLinks: Joi.number().default(5).description('How many related courses to show'),
    catalogId: Joi.array()
  }).external(async pluginOptions => {
    try {
      await fetch(
        `${pluginOptions.baseUrl}/learn/v1/courses`
      );
    } catch (err) {
      throw new Error(
        `Cannot access Docebo with the provided url "${pluginOptions.baseUrl}". Double check it is correct and try again`
      );
    }
  });
};
