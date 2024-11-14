## Description
Gatsby source plugin for building websites using Docebo as a data source

## How to install

```shell
npm install gatsby-source-docebo
```

## How to query

gatsby-config.js
```js:title=gatsby-config.js
module.exports = {
  plugins: [
    {
      resolve: `gatsby-source-docebo`,
      options: {
        // Replace your domain with you account url
        baseUrl: 'https://yourdomain.docebosaas.com',
        // Add id for which catalogs to create
        catalogId: [4],
        // Add number for how many courses to appear in the related field. Default is 5
        relatedLinks: 5
      },
    },
  ],
}
```

gatsby-node.js
```js:title=gatsby-node.js
const path = require('path');

async function createPages({ graphql, createPage, contentType, component, path }) {
  const prefix = path || '';
  const { errors, data } = await graphql(`
    query {
      ${contentType} {
        edges {
          node {
            slug
          }
        }
      }
    }
  `)
  if (errors) {
    return errors.forEach(err => console.log(err));
  }
  const template = data[contentType];
  template.edges.forEach(edge => {
    createPage({
      path: `${prefix}${edge.node.slug}`,
      component: component,
      context: {
        slug: edge.node.slug
      }
    })
  })
}

exports.createPages = async ({ graphql, actions }) => {
  const { createPage } = actions;
  const course = path.resolve('./src/templates/Course.js');

  await Promise.all([
    createPages({
      graphql,
      createPage,
      contentType: 'allCoursePages',
      component: course,
      path: '/courses/'
    })
  ]);
}
```

course.js (Template)
```js:title=course.js
import React from 'react';
import { graphql } from 'gatsby';

export const query = graphql`
  query($slug: String!) {
    coursePages(slug: { eq: $slug }) {
      id
      uidCourse
      name
      slug
      img
      description
      credits
      duration
      additionalFields {
        id
        title
        value
        visible_to_user
      }
      tree {
        name
        type
      }
      relatedCourses {
        id_course
        name
        slug
        image
      }
    }
  }
`

const Course = ({ data }) => {
  return (
    <div>
      <h1>{data?.name}</h1>
      <p>{data?.description}</p>
    </div>
  );
};

export default Course

```

## How to contribute

If you have any questions or would like to contribue. You can contact me at christopher.norkett@gmail.com