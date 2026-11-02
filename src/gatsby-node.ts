import { createHash } from 'crypto';
import type { GatsbyNode, PluginOptions, Reporter } from 'gatsby';

/** Options accepted by this plugin in gatsby-config. */
export interface DoceboPluginOptions extends PluginOptions {
  /** Your Docebo account url, e.g. https://yourdomain.docebosaas.com */
  baseUrl: string;
  /** Ids of the catalogs to source courses from */
  catalogId?: Array<number | string>;
  /** How many related courses to include per course. Default is 5 */
  relatedLinks?: number;
}

/** A single item returned by the catalog endpoint. */
export interface DoceboCatalogItem {
  item_id: number | string;
  access_status: number;
  [key: string]: unknown;
}

interface DoceboCatalogResponse {
  data: {
    items: DoceboCatalogItem[];
    current_page: number;
    has_more_data: boolean;
  };
}

export interface DoceboAdditionalField {
  id: number | string;
  title: string;
  value: unknown;
  visible_to_user: boolean;
  [key: string]: unknown;
}

export interface DoceboTreeItem {
  name: string;
  type: string;
  [key: string]: unknown;
}

/** Course details returned by the course endpoint. */
export interface DoceboCourse {
  id: number | string;
  slug_name?: string;
  thumbnail?: string;
  uidCourse?: string;
  name?: string;
  description?: string;
  duration?: number;
  credits?: number;
  additional_fields?: DoceboAdditionalField[];
  tree?: DoceboTreeItem[];
  [key: string]: unknown;
}

interface DoceboCourseResponse {
  data?: DoceboCourse;
}

export interface DoceboRelatedCourseItem {
  id_course: number | string;
  name?: string;
  image?: string;
  [key: string]: unknown;
}

interface DoceboRelatedCoursesResponse {
  data: {
    items: DoceboRelatedCourseItem[];
  };
}

interface RelatedCourses {
  id: number | string;
  items: Array<DoceboRelatedCourseItem & { slug?: string }>;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Helper function for retrying failed requests
const fetchWithRetry = async <T>(
  url: string,
  options: RequestInit = {},
  retries = 3,
  delay = 1000
): Promise<T> => {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return (await response.json()) as T;
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry<T>(url, options, retries - 1, delay * 2); // Exponential backoff
    }
    throw err;
  }
};

const isFulfilled = <T>(
  result: PromiseSettledResult<T>
): result is PromiseFulfilledResult<T> => result.status === 'fulfilled';

const isPresent = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined;

// Get courses by catalog id
const getCatalogById = async (
  baseUrl: string,
  reporter: Reporter,
  id: number | string,
  page: number
): Promise<DoceboCatalogResponse | null> => {
  try {
    return await fetchWithRetry<DoceboCatalogResponse>(
      `${baseUrl}/learn/v1/catalog/${id}?page=${page}`
    );
  } catch (err) {
    reporter.error(`Docebo: Failed to fetch catalog ${id}: ${errorMessage(err)}`);
    return null;
  }
};

const getCoursesByCatalogId = async (
  baseUrl: string,
  reporter: Reporter,
  id: number | string
): Promise<DoceboCatalogItem[]> => {
  let records: DoceboCatalogItem[] = [];
  let page = 1;
  reporter.info(`Docebo: Retrieving data for catalog id: ${id}`);
  const activity = reporter.activityTimer(`Docebo: Records retrieved for catalog id: ${id}`);
  activity.start();
  for (;;) {
    const res = await getCatalogById(baseUrl, reporter, id, page);
    if (!res) {
      activity.end();
      return records;
    }
    records = [...records, ...res.data.items];
    page = res.data.current_page + 1;

    if (!res.data.has_more_data) {
      reporter.info(`Docebo: Retrieved ${records.length} records for catalog id: ${id}`);
      activity.end();
      return records;
    }
  }
};

// Create a custom content type from Docebo API
export const sourceNodes: GatsbyNode['sourceNodes'] = async (
  { actions, reporter },
  pluginOptions
) => {
  const { createNode } = actions;
  const { baseUrl, catalogId = [], relatedLinks } = pluginOptions as DoceboPluginOptions;

  // Combine all catalogs
  const result = await Promise.all(
    catalogId.map(id => getCoursesByCatalogId(baseUrl, reporter, id))
  );
  const combinedCatalogs = result
    .flat()
    .filter(({ access_status }) => access_status === 1);

  if (combinedCatalogs.length === 0) {
    reporter.error('Docebo: No valid courses found in combined catalogs.');
    return;
  }

  // Get individual course data by id
  const courses = await Promise.allSettled(
    combinedCatalogs.map(async ({ item_id }) => {
      try {
        const data = await fetchWithRetry<DoceboCourseResponse>(
          `${baseUrl}/learn/v1/courses/${item_id}`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            },
            redirect: 'follow',
          }
        );
        return data?.data ?? null;
      } catch (err) {
        reporter.error(`Docebo: Failed to fetch course ${item_id}: ${errorMessage(err)}`);
        return null;
      }
    })
  );

  const successfulCourses = courses
    .filter(isFulfilled)
    .map(r => r.value)
    .filter(isPresent);

  // Get related courses by course id
  const relatedCourses = await Promise.allSettled(
    combinedCatalogs.map(async ({ item_id }): Promise<RelatedCourses | null> => {
      try {
        const res = await fetchWithRetry<DoceboRelatedCoursesResponse>(
          `${baseUrl}/learn/v1/courses/${item_id}/by_category?page_size=${relatedLinks}`
        );
        const items: RelatedCourses['items'] = [];
        res.data.items.forEach(item => {
          // Compare as strings: ids may come back as either numbers or strings
          const course = successfulCourses.find(x => String(x.id) === String(item.id_course));
          if (course) items.push({ slug: course.slug_name, ...item });
        });
        return { id: item_id, items };
      } catch (err) {
        reporter.error(
          `Docebo: Failed to fetch related courses for ${item_id}: ${errorMessage(err)}`
        );
        return null;
      }
    })
  );

  const successfulRelatedCourses = relatedCourses
    .filter(isFulfilled)
    .map(r => r.value)
    .filter(isPresent);

  // Map into these results and create nodes
  reporter.info(`Docebo: Creating ${successfulCourses.length} Course nodes`);
  const activity = reporter.activityTimer(`Docebo: Course nodes created`);
  activity.start();
  successfulCourses.forEach(course => {
    const related = successfulRelatedCourses.find(x => String(x.id) === String(course.id));
    createNode({
      id: `${course.id}`,
      parent: `__SOURCE__`,
      internal: {
        type: `CoursePages`,
        contentDigest: createHash(`md5`).update(JSON.stringify(course)).digest(`hex`),
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
      relatedCourses: related?.items,
    });
  });
  activity.end();
};

// Options schema and testing
export const pluginOptionsSchema: GatsbyNode['pluginOptionsSchema'] = ({ Joi }) => {
  return Joi.object({
    baseUrl: Joi.string()
      .required()
      .description('Your docebo url')
      .messages({
        'any.required': 'You must provide your docebo url',
      }),
    relatedLinks: Joi.number().default(5).description('How many related courses to show'),
    catalogId: Joi.array(),
  }).external(async (pluginOptions: DoceboPluginOptions) => {
    try {
      await fetch(`${pluginOptions.baseUrl}/learn/v1/courses`);
    } catch {
      throw new Error(
        `Cannot access Docebo with the provided url "${pluginOptions.baseUrl}". Double check it is correct and try again`
      );
    }
  });
};
