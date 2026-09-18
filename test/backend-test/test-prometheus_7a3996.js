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
            assert.deepStrictEqual(result, { env: "prod" });
        });

        test("sanitizes special characters out of the tag name", () => {
            const result = mapTags([ { name: "en-v!@#", value: "prod" } ]);
            assert.deepStrictEqual(result, { env: "prod" });
        });

        test("sanitizes special characters out of the tag value", () => {
            const result = mapTags([ { name: "env", value: "pr@od!" } ]);
            assert.deepStrictEqual(result, { env: "prod" });
        });

        test("strips leading digits from the tag name", () => {
            const result = mapTags([ { name: "1env", value: "prod" } ]);
            assert.deepStrictEqual(result, { env: "prod" });
        });

        test("skips tags whose sanitized name is empty", () => {
            const result = mapTags([ { name: "123", value: "prod" } ]);
            assert.deepStrictEqual(result, {});
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
            assert.deepStrictEqual(result, { sslcert: "sslcert" });
        });

        test("a name-only tag (empty string value) maps to the tag name as fallback value", () => {
            const result = mapTags([ { name: "sslcert", value: "" } ]);
            assert.deepStrictEqual(result, { sslcert: "sslcert" });
        });

        // A monitor can carry the same tag more than once with different
        // values: the "monitor_tag" table has no unique constraint on
        // (monitor_id, tag_id), and deleteMonitorTag deletes by value, so
        // this is an intentional, reachable state, not a contrived one.
        describe("repeated tags (same tag applied more than once to a monitor)", () => {
            test("two explicit values collapse to the alphabetically first one, regardless of order", () => {
                const east = mapTags([
                    { name: "region", value: "us-east" },
                    { name: "region", value: "us-west" },
                ]);
                const west = mapTags([
                    { name: "region", value: "us-west" },
                    { name: "region", value: "us-east" },
                ]);
                assert.deepStrictEqual(east, { region: "useast" });
                assert.deepStrictEqual(west, { region: "useast" });
            });

            test("an explicit value always wins over the name-only fallback, regardless of order", () => {
                const valueFirst = mapTags([
                    { name: "region", value: "us-west" },
                    { name: "region", value: "" },
                ]);
                const valueLast = mapTags([
                    { name: "region", value: "" },
                    { name: "region", value: "us-west" },
                ]);
                assert.deepStrictEqual(valueFirst, { region: "uswest" });
                assert.deepStrictEqual(valueLast, { region: "uswest" });
            });

            test("multiple name-only occurrences still resolve to the single fallback value", () => {
                const result = mapTags([
                    { name: "region", value: "" },
                    { name: "region", value: null },
                ]);
                assert.deepStrictEqual(result, { region: "region" });
            });
        });

        // Two distinct tags (different names, different DB rows) can
        // sanitize to the same Prometheus label, e.g. "SSL Cert",
        // "SSLCert" and "SSL-Cert" all become "SSLCert". Prometheus.init()
        // already dedupes this when registering label *names* (see its
        // Set-based dedup and comment); mapTagsToLabels() must resolve the
        // colliding *values* just as deterministically, the same way it
        // does for a literally repeated tag above.
        describe("sanitized-name collisions between distinct tags", () => {
            test("an explicit value on one of the colliding tags wins over the other's name-only fallback", () => {
                const result = mapTags([
                    { name: "SSL Cert", value: "" },
                    { name: "SSLCert", value: "valid" },
                ]);
                assert.deepStrictEqual(result, { SSLCert: "valid" });
            });

            test("two colliding tags with explicit values collapse to the alphabetically first one", () => {
                const result = mapTags([
                    { name: "SSL Cert", value: "zeta" },
                    { name: "SSL-Cert", value: "alpha" },
                ]);
                assert.deepStrictEqual(result, { SSLCert: "alpha" });
            });
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
            for (const name of [ "sslcert", "env", "region", "SSLCert" ]) {
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

        // Anchors the compatibility requirement for existing dashboards: a
        // monitor with a single, ordinary valued tag - by far the common
        // case today - must keep exporting exactly the same label value it
        // always has, unaffected by how collisions are now resolved.
        test("an existing single-tag monitor keeps exporting the exact same label value (backward compatibility)", async () => {
            const prometheus = new Prometheus(makeMonitor(2), [ { name: "env", value: "prod" } ]);
            prometheus.update({ status: 1, ping: 42 }, undefined, null);

            const text = await PrometheusClient.register.metrics();
            const statusLine = findMetricLine(text, "monitor_status", 2);

            assert.ok(statusLine, "monitor_status series for monitor_id=2 was not exported");
            assert.match(statusLine, /env="prod"/);
        });

        test("a repeated tag never produces a comma-joined compound label value", async () => {
            const prometheus = new Prometheus(makeMonitor(3), [
                { name: "region", value: "" },
                { name: "region", value: "us-west" },
            ]);
            prometheus.update({ status: 1, ping: 42 }, undefined, null);

            const text = await PrometheusClient.register.metrics();
            const statusLine = findMetricLine(text, "monitor_status", 3);

            assert.ok(statusLine, "monitor_status series for monitor_id=3 was not exported");
            assert.match(statusLine, /region="uswest"/);
            assert.doesNotMatch(statusLine, /region="region,uswest"/);
        });

        // Documents a real, separate lifecycle gap found while investigating
        // this issue: monitor.start() builds `this.prometheus` exactly once
        // from getTags() (server/model/monitor.js:426). The addMonitorTag /
        // editMonitorTag / deleteMonitorTag socket handlers
        // (server/server.js:970-1030) only write to the "monitor_tag" table
        // and never rebuild that instance or call restartMonitor(). This
        // test pins today's actual behavior - the exporter keeps serving
        // the tag set from whenever the monitor last started - so it is
        // documented rather than silently changed. Fixing it (refreshing
        // the exporter's label set on a live tag edit) is a separate,
        // larger change than this issue's scope.
        test("editing a monitor's tags does not update its exported labels without a monitor restart", async () => {
            const monitor = makeMonitor(4);
            const prometheus = new Prometheus(monitor, [ { name: "env", value: "staging" } ]);
            prometheus.update({ status: 1, ping: 10 }, undefined, null);

            let text = await PrometheusClient.register.metrics();
            let statusLine = findMetricLine(text, "monitor_status", 4);
            assert.match(statusLine, /env="staging"/);

            // Simulates editMonitorTag changing the tag's value in the
            // database while the monitor keeps running: nothing rebuilds
            // `prometheus`, so further updates keep using the tag set
            // captured at construction time.
            prometheus.update({ status: 1, ping: 10 }, undefined, null);

            text = await PrometheusClient.register.metrics();
            statusLine = findMetricLine(text, "monitor_status", 4);
            assert.match(
                statusLine,
                /env="staging"/,
                "exporter should still show the value from monitor start until the monitor is restarted"
            );
        });
    });
});
