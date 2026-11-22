/**
 * Numbers for monitoring, in the Prometheus text format any monitoring
 * service can read from `GET /metrics`.
 *
 * Labels are only ever route patterns, methods and status codes, never ids
 * or anything a person typed, so no personal data reaches monitoring and the
 * number of series stays small.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string>;
const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}) {
    return this.values.get(key(labels)) ?? 0;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines;
  }
}

class Histogram {
  private series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(labels: Labels, seconds: number) {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    for (const [i, b] of BUCKETS.entries()) if (seconds <= b) s.buckets[i]++;
    s.sum += seconds;
    s.count++;
    this.series.set(k, s);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      for (const [i, b] of BUCKETS.entries()) lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`);
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines;
  }
}

export class Metrics {
  readonly requests = new Counter('finken_http_requests_total', 'Requests answered, by route, method and status.');
  readonly duration = new Histogram('finken_http_request_duration_seconds', 'Time to answer, by route and method.');
  readonly records = new Counter('finken_batch_records_total', 'Records saved or deleted through batches.');
  readonly refused = new Counter('finken_batch_refused_total', 'Batches refused, by reason (shape, permission, money_rules, conflict).');
  readonly limited = new Counter('finken_rate_limited_total', 'Requests stopped by a rate limit, by limit.');
  readonly clientErrors = new Counter('finken_client_errors_total', 'Errors reported by the web app.');
  private started = Date.now();

  render(): string {
    const lines = [
      ...this.requests.render(),
      ...this.duration.render(),
      ...this.records.render(),
      ...this.refused.render(),
      ...this.limited.render(),
      ...this.clientErrors.render(),
      '# HELP finken_uptime_seconds Seconds since this process started.',
      '# TYPE finken_uptime_seconds gauge',
      `finken_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}
