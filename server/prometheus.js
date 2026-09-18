const PrometheusClient = require("prom-client");
const { log } = require("../src/util");
const { R } = require("redbean-node");

let monitorCertDaysRemaining = null;
let monitorCertIsValid = null;
let monitorUptimeRatio = null;
let monitorAverageResponseTimeSeconds = null;
let monitorResponseTime = null;
let monitorStatus = null;

class Prometheus {
    monitorLabelValues = {};

    /**
     * @param {object} monitor Monitor object to monitor
     * @param {Array<{name:string,value:?string}>} tags Tags to add to the monitor
     */
    constructor(monitor, tags) {
        this.monitorLabelValues = {
            ...this.mapTagsToLabels(tags),
            monitor_id: monitor.id,
            monitor_name: monitor.name,
            monitor_type: monitor.type,
            monitor_url: monitor.url,
            monitor_hostname: monitor.hostname,
            monitor_port: monitor.port,
        };
    }

    /**
     * Initialize Prometheus metrics, and add all available tags as possible labels.
     * This should be called once at the start of the application.
     * New tags will NOT be added dynamically, a restart is sadly required to add new tags to the metrics.
     * Existing tags added to monitors will be updated automatically.
     * @returns {Promise<void>}
     */
    static async init() {
        // Add all available tags as possible labels,
        // and use Set to remove possible duplicates (for when multiple tags contain non-ascii characters, and thus are sanitized to the same label)
        const tags = new Set(
            (await R.findAll("tag"))
                .map((tag) => {
                    return Prometheus.sanitizeForPrometheus(tag.name);
                })
                .filter((tagName) => {
                    return tagName !== "";
                })
                .sort(this.sortTags)
        );

        const commonLabels = [
            ...tags,
            "monitor_id",
            "monitor_name",
            "monitor_type",
            "monitor_url",
            "monitor_hostname",
            "monitor_port",
        ];

        monitorCertDaysRemaining = new PrometheusClient.Gauge({
            name: "monitor_cert_days_remaining",
            help: "The number of days remaining until the certificate expires",
            labelNames: commonLabels,
        });

        monitorCertIsValid = new PrometheusClient.Gauge({
            name: "monitor_cert_is_valid",
            help: "Is the certificate still valid? (1 = Yes, 0= No)",
            labelNames: commonLabels,
        });

        monitorUptimeRatio = new PrometheusClient.Gauge({
            name: "monitor_uptime_ratio",
            help: "Uptime ratio calculated over sliding window specified by the 'window' label. (0.0 - 1.0)",
            labelNames: [...commonLabels, "window"],
        });

        monitorAverageResponseTimeSeconds = new PrometheusClient.Gauge({
            name: "monitor_response_time_seconds",
            help: "Average response time in seconds calculated over sliding window specified by the 'window' label",
            labelNames: [...commonLabels, "window"],
        });

        monitorResponseTime = new PrometheusClient.Gauge({
            name: "monitor_response_time",
            help: "Monitor Response Time (ms)",
            labelNames: commonLabels,
        });

        monitorStatus = new PrometheusClient.Gauge({
            name: "monitor_status",
            help: "Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)",
            labelNames: commonLabels,
        });
    }

    /**
     * Sanitize a string to ensure it can be used as a Prometheus label or value.
     * See https://github.com/louislam/uptime-kuma/pull/4704#issuecomment-2366524692
     * @param {string} text The text to sanitize
     * @returns {string} The sanitized text
     */
    static sanitizeForPrometheus(text) {
        text = text.replace(/[^a-zA-Z0-9_]/g, "");
        text = text.replace(/^[^a-zA-Z_]+/, "");
        return text;
    }

    /**
     * Map the tags value to valid labels used in Prometheus. Sanitize them in the process.
     *
     * A Prometheus label can only hold a single scalar value. Two source tags can collide
     * into the same label here in two ways: the same tag applied more than once to a
     * monitor with different values (the "monitor_tag" table has no unique constraint on
     * monitor+tag), or two distinct tag names that sanitize to the same label (e.g.
     * "SSL Cert" and "SSL-Cert" both become "SSLCert"). Silently joining every colliding
     * value (e.g. into an array later coerced to "a,b" by the Prometheus client) would
     * break equality and presence filtering in PromQL the same way an empty value does, so
     * collisions are resolved deterministically instead: an explicit value always wins over
     * the name-only fallback, and among multiple explicit values the alphabetically first
     * one wins, regardless of the order the tags were given in.
     * @param {Array<{name: string, value:?string}>} tags The tags to map
     * @returns {object} The mapped tags, usable as labels
     */
    mapTagsToLabels(tags) {
        let mappedValues = {};
        let hasExplicitValue = {};

        tags.forEach((tag) => {
            let sanitizedTag = Prometheus.sanitizeForPrometheus(tag.name);
            if (sanitizedTag === "") {
                return; // Skip empty tag names
            }

            let tagValue = Prometheus.sanitizeForPrometheus(tag.value || "");

            if (tagValue !== "") {
                if (!hasExplicitValue[sanitizedTag] || tagValue < mappedValues[sanitizedTag]) {
                    mappedValues[sanitizedTag] = tagValue;
                    hasExplicitValue[sanitizedTag] = true;
                }
            } else if (mappedValues[sanitizedTag] === undefined) {
                // Name-only tag: fall back to the tag name itself so the label stays
                // non-empty and distinguishable from an absent tag in PromQL.
                mappedValues[sanitizedTag] = sanitizedTag;
            }
        });

        // Order the tags alphabetically
        return Object.keys(mappedValues)
            .sort(this.sortTags)
            .reduce((obj, key) => {
                obj[key] = mappedValues[key];
                return obj;
            }, {});
    }

    /**
     * Update the metrics page
     * @typedef {import("./uptime-calculator").UptimeDataResult} UptimeDataResult
     * @param {object} heartbeat Heartbeat details
     * @param {object} tlsInfo TLS details
     * @param {{data24h: UptimeDataResult, data30d: UptimeDataResult, data1y:UptimeDataResult} | null} uptime the uptime and average response rate over a variety of fixed windows
     * @returns {void}
     */
    update(heartbeat, tlsInfo, uptime) {
        if (typeof tlsInfo !== "undefined") {
            try {
                let isValid;
                if (tlsInfo.valid === true) {
                    isValid = 1;
                } else {
                    isValid = 0;
                }
                monitorCertIsValid.set(this.monitorLabelValues, isValid);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }

            try {
                if (tlsInfo.certInfo != null) {
                    monitorCertDaysRemaining.set(this.monitorLabelValues, tlsInfo.certInfo.daysRemaining);
                }
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
        }

        if (uptime) {
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...this.monitorLabelValues, window: "1d" },
                    uptime.data24h.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...this.monitorLabelValues, window: "30d" },
                    uptime.data30d.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...this.monitorLabelValues, window: "365d" },
                    uptime.data1y.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...this.monitorLabelValues, window: "1d" }, uptime.data24h.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...this.monitorLabelValues, window: "30d" }, uptime.data30d.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...this.monitorLabelValues, window: "365d" }, uptime.data1y.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
        }

        if (heartbeat) {
            try {
                monitorStatus.set(this.monitorLabelValues, heartbeat.status);
            } catch (e) {
                log.error("prometheus", "Caught error");
                log.error("prometheus", e);
            }

            try {
                if (typeof heartbeat.ping === "number") {
                    monitorResponseTime.set(this.monitorLabelValues, heartbeat.ping);
                } else {
                    // Is it good?
                    monitorResponseTime.set(this.monitorLabelValues, -1);
                }
            } catch (e) {
                log.error("prometheus", "Caught error");
                log.error("prometheus", e);
            }
        }
    }

    /**
     * Remove monitor from prometheus
     * @returns {void}
     */
    remove() {
        try {
            monitorCertDaysRemaining.remove(this.monitorLabelValues);
            monitorCertIsValid.remove(this.monitorLabelValues);
            ["1d", "30d", "365d"].forEach((window) => {
                monitorUptimeRatio.remove({ ...this.monitorLabelValues, window });
                monitorAverageResponseTimeSeconds.remove({ ...this.monitorLabelValues, window });
            });
            monitorResponseTime.remove(this.monitorLabelValues);
            monitorStatus.remove(this.monitorLabelValues);
        } catch (e) {
            console.error(e);
        }
    }

    /**
     * Sort the tags alphabetically, case-insensitive.
     * @param {string} a The first tag to compare
     * @param {string} b The second tag to compare
     * @returns {number} The alphabetical order number
     */
    sortTags(a, b) {
        const aLowerCase = a.toLowerCase();
        const bLowerCase = b.toLowerCase();

        if (aLowerCase < bLowerCase) {
            return -1;
        }

        if (aLowerCase > bLowerCase) {
            return 1;
        }

        return 0;
    }
}

module.exports = {
    Prometheus,
};
