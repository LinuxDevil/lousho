/**
 * Integrations
 * The credentialed third-party tools - Jira, Confluence, GitHub, Slack, email,
 * Google Workspace, Jenkins and Figma. They
 * used to ship on the package root (and `./tools`); import them from
 * `lousho/integrations`. The files themselves still live in
 * `src/tools/built-in/`; this barrel only re-exports them.
 */

export * from '../tools/built-in/email';
export * from '../tools/built-in/jira';
export * from '../tools/built-in/github';
export * from '../tools/built-in/slack';
export * from '../tools/built-in/confluence';
export * from '../tools/built-in/slackApi';
export * from '../tools/built-in/google';
export * from '../tools/built-in/jenkins';
export { FigmaTools, createFigmaTools, type FigmaConfig } from '../tools/built-in/figma';
