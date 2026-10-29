export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Bodies often carry URLs and stack traces.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
