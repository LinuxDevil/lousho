# tracing

`AgentExecutor.execute()` running a small weather scenario with two trace exporters. Both run offline with a mock model.

| File | What it shows |
|---|---|
| `console-exporter.ts` | The smallest `TraceExporter`: one indented line per span start and end. A template for your own backend bridge. |
| `run-console.ts` | The scenario with the console exporter. |
| `run-otel.ts` | The scenario with the bundled `createOtelTraceExporter()`, an OpenTelemetry `NodeTracerProvider` and OTel's console exporters, so spans and the GenAI metrics print without a collector. |
| `weather-scenario.ts` | The shared agent and tool. |

## Run it

```bash
npm run example:tracing:console
npm run example:tracing:otel
```
