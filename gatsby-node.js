const axios = require('axios');
const crypto = require('crypto');
const _ = require('lodash');

// Create a custom content type from Docebo API
exports.sourceNodes = async ({ actions, reporter }, { baseUrl, catalogId, relatedLinks }) => {
  const { createNode } = actions;

  // Get courses by catalog id
  const getCatalogById = (id, page) => {
    return axios({
      method: 'GET',
      url: `${baseUrl}/learn/v1/catalog/${id}?page=${page}`
    })
  };

  const getCoursesByCatalogId = async (id) => {
    let records = [];
    let keepGoing = true
    let page = 1
    reporter.info(`Docebo: Retreiving data for catalog id: ${id}`);
    const activity = reporter.activityTimer(`Docebo: Records retrieved for catalog id: ${id}`);
    activity.start()
    while (keepGoing) {
      const { data } = await getCatalogById(id, page);
      
      records = [...records, ...data.data.items];
      page = data.data.current_page + 1;
      
      if (!data.data.has_more_data) {
        keepGoing = false;
        reporter.info(`Docebo: Retreived ${records.length} records for catalog id: ${id}`);
        activity.end()
        return records;
      }
    }
  }

  // Combine all catalogs
  let catalogs = [];
  for (let i = 0; i < catalogId?.length; i++) {
    catalogs.push(getCoursesByCatalogId(catalogId[i]))
  }
  const result = await Promise.all(catalogs);
  const combinedCatalogs = _.flatten(result).filter(({access_status}) => access_status === 1);

  // Get individual course data by id
  const courses = await Promise.all(
    combinedCatalogs.map(async ({ item_id }) => {
      try {
        const res = await axios({
          method: 'GET',
          url: `${baseUrl}/learn/v1/courses/${item_id}`,
        });
        return res?.data?.data;
      } catch (err) {
        console.log(err)
      }
    })
  );

  // Get related courses by course id
  const relatedCourses = await Promise.all(
    combinedCatalogs.map(async ({ item_id }) => {
      try {
        const res = await axios({
          method: 'GET',
          url: `${baseUrl}/learn/v1/courses/${item_id}/by_category?page_size=${relatedLinks}`,
        });
        let items = [];
        res.data.data.items.forEach(item => {
          const course = courses.find( x => x.id == item.id_course);
          return items.push({slug: course.slug_name, ...item})
        });
        return { id: item_id, items: items };
      } catch (err) {
        console.log(err);
      }
    })
  );

  // Map into these results and create nodes
  reporter.info(`Docebo: Creating ${courses.length} Course nodes`);
  const activity = reporter.activityTimer(`Docebo: Course nodes created`);
  activity.start();
  courses.map(course => {
    const related = relatedCourses.find(x => x.id == course.id);
    // Create your node object
    const courseNode = {
      // Required fields
      id: `${course.id}`,
      parent: `__SOURCE__`,
      internal: {
        type: `CoursePages`
      },
      slug: course.slug_name,
      img: course.thumbnail,
      uidCourse: course.uidCourse,
      name: course.name,
      description: course.description,
      duration: course.duration,
      credits: course.credits,
      additionalFields: course.additional_fields,
      tree: course.tree,
      relatedCourses: related.items
    }

    // Get content digest of node. (Required field)
    const contentDigest = crypto
      .createHash(`md5`)
      .update(JSON.stringify(courseNode))
      .digest(`hex`);
    // add it to userNode
    courseNode.internal.contentDigest = contentDigest;

    // Create node with the gatsby createNode() API
    createNode(courseNode);
    
  });
  activity.end();
  return;
}

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
      await axios({
        method: 'GET',
        url: `${pluginOptions.baseUrl}/learn/v1/courses`
      });
    } catch (err) {
      throw new Error(
        // `Cannot access Docebo with the provided url "${pluginOptions.baseUrl}". Double check it is correct and try again`
        console.log({err})
      )
    }
  })
}
