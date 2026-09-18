process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

// Must be required before "../mock-testdb" / "../../server/database": those
// two modules have a circular require (database.js -> better-auth.ts ->
// database.js), and depending on which one loads first, better-auth.ts can
// end up seeing a stale, pre-init snapshot of Database's exports later.
// Resolving better-auth.ts fully up front avoids that.
require("../../server/better-auth");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const PrometheusClient = require("prom-client");
const { Prometheus } = require("../../server/prometheus");
const TestDB = require("../mock-testdb");

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

    describe("metrics output", () => {
        const testDb = new TestDB("./data/test-prometheus-metrics");

        /**
         * Build a minimal monitor-like object, just enough to satisfy the
         * Prometheus constructor and update().
         * @param {number} id Monitor id
         * @returns {object} A monitor-like object
         */
        function makeMonitor(id) {
            return {
                id,
                name: `Monitor ${id}`,
                type: "http",
                url: "https://example.com",
                hostname: null,
                port: null,
            };
        }

        /**
         * Find the exported line for a given metric name and monitor_id in
         * the raw Prometheus exposition text.
         * @param {string} text Exposition text from PrometheusClient.register.metrics()
         * @param {string} metricName Metric name, e.g. "monitor_status"
         * @param {number} monitorId Monitor id to match on
         * @returns {?string} The matching line, or undefined if not found
         */
        function findMetricLine(text, metricName, monitorId) {
            return text
                .split("\n")
                .find((line) => line.startsWith(`${metricName}{`) && line.includes(`monitor_id="${monitorId}"`));
        }

        before(async () => {
            await testDb.create();

            // Prometheus.init() snapshots every known tag NAME from the DB
            // once at startup, to register it as a possible Gauge label. A
            // tag must exist here before it can appear as a label in
            // exported metrics.
            for (const name of [ "sslcert", "env" ]) {
                const bean = R.dispense("tag");
                bean.name = name;
                bean.color = "#000000";
                await R.store(bean);
            }

            await Prometheus.init();
        });

        after(async () => {
            PrometheusClient.register.clear();
            await testDb.destroy();
        });

        test("a name-only tag is exported as a non-empty, presence-filterable label", async () => {
            const prometheus = new Prometheus(makeMonitor(1), [ { name: "sslcert", value: "" } ]);
            prometheus.update({ status: 1, ping: 42 }, undefined, null);

            const text = await PrometheusClient.register.metrics();
            const statusLine = findMetricLine(text, "monitor_status", 1);

            assert.ok(statusLine, "monitor_status series for monitor_id=1 was not exported");
            assert.match(statusLine, /sslcert="sslcert"/);
            assert.doesNotMatch(statusLine, /sslcert=""/);
        });

        test("a tag with an explicit value keeps that value in the exported label", async () => {
            const prometheus = new Prometheus(makeMonitor(2), [ { name: "env", value: "prod" } ]);
            prometheus.update({ status: 1, ping: 42 }, undefined, null);

            const text = await PrometheusClient.register.metrics();
            const statusLine = findMetricLine(text, "monitor_status", 2);

            assert.ok(statusLine, "monitor_status series for monitor_id=2 was not exported");
            assert.match(statusLine, /env="prod"/);
        });
    });
});
