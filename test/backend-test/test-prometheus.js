const { describe, test } = require("node:test");
const assert = require("node:assert");
const { Prometheus } = require("../../server/prometheus");

/**
 * Call mapTagsToLabels() on a bare Prometheus instance, without needing
 * a real monitor or a database connection.
 * @param {Array<{name: string, value: ?string}>} tags Tags to map
 * @returns {object} The mapped tags, usable as labels
 */
function mapTags(tags) {
    const prometheus = Object.create(Prometheus.prototype);
    return prometheus.mapTagsToLabels(tags);
}

describe("Prometheus", () => {
    describe("mapTagsToLabels()", () => {
        test("maps a single tag with a value", () => {
            const result = mapTags([ { name: "env", value: "prod" } ]);
            assert.deepStrictEqual(result, { env: [ "prod" ] });
        });

        test("sanitizes special characters out of the tag name", () => {
            const result = mapTags([ { name: "en-v!@#", value: "prod" } ]);
            assert.deepStrictEqual(result, { env: [ "prod" ] });
        });

        test("sanitizes special characters out of the tag value", () => {
            const result = mapTags([ { name: "env", value: "pr@od!" } ]);
            assert.deepStrictEqual(result, { env: [ "prod" ] });
        });

        test("strips leading digits from the tag name", () => {
            const result = mapTags([ { name: "1env", value: "prod" } ]);
            assert.deepStrictEqual(result, { env: [ "prod" ] });
        });

        test("skips tags whose sanitized name is empty", () => {
            const result = mapTags([ { name: "123", value: "prod" } ]);
            assert.deepStrictEqual(result, {});
        });

        test("keeps multiple values for the same tag name, sorted alphabetically", () => {
            const result = mapTags([
                { name: "env", value: "prod" },
                { name: "env", value: "beta" },
            ]);
            assert.deepStrictEqual(result, { env: [ "beta", "prod" ] });
        });

        test("orders tag names alphabetically, case-insensitively", () => {
            const result = mapTags([
                { name: "Zone", value: "a" },
                { name: "apex", value: "b" },
            ]);
            assert.deepStrictEqual(Object.keys(result), [ "apex", "Zone" ]);
        });

        test("a name-only tag (null value) maps to the tag name as fallback value", () => {
            const result = mapTags([ { name: "sslcert", value: null } ]);
            assert.deepStrictEqual(result, { sslcert: [ "sslcert" ] });
        });
        
        test("a name-only tag (empty string value) maps to the tag name as fallback value", () => {
            const result = mapTags([ { name: "sslcert", value: "" } ]);
            assert.deepStrictEqual(result, { sslcert: [ "sslcert" ] });
        });
    });
});
