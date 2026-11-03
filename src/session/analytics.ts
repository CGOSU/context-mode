/**
 * Stable public entry point for analytics.
 *
 * Collection owns SQLite/filesystem access and aggregation. Reporting consumes
 * explicit statistics without depending on collection or adapter loaders.
 */
export * from "./analytics-types.js";
export * from "./analytics-labels.js";
export * from "./analytics-collection.js";
export * from "./analytics-report.js";
