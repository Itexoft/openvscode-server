# Telemetry Bypass Strategies

## src/vs/platform/telemetry/common/1dsAppender.ts
```
const endpointUrl = 'https://mobile.events.data.microsoft.com/OneCollector/1.0';
aiClient.track({
    name,
    baseData: { name, properties: data?.properties, measurements: data?.measurements }
});
```
Replace `aiClient.track` with a no-op function so calls succeed without sending data.

## extensions/github/src/extension.ts
```
const { aiKey } = context.extension.packageJSON as { aiKey: string };
const telemetryReporter = new TelemetryReporter(aiKey);
```
Provide a stub `TelemetryReporter` that drops events and implements the same API.

## extensions/markdown-language-features/src/telemetryReporter.ts
```
class ExtensionReporter implements TelemetryReporter {
    private readonly _reporter: VSCodeTelemetryReporter;
    constructor(
            packageInfo: IPackageInfo
    ) {
            this._reporter = new VSCodeTelemetryReporter(packageInfo.aiKey);
    }
}
```
Replace `VSCodeTelemetryReporter` with a wrapper whose `sendTelemetryEvent` returns immediately.

## extensions/git/src/main.ts
```
import TelemetryReporter from '@vscode/extension-telemetry';
async function createModel(context: ExtensionContext, logger: LogOutputChannel, telemetryReporter: TelemetryReporter, disposables: Disposable[]): Promise<Model> {
    const model = new Model(git, askpass, context.globalState, context.workspaceState, logger, telemetryReporter);
```
Pass a reporter instance where all methods are empty to avoid network calls.

## extensions/json-language-features/client/src/node/jsonClientMain.ts
```
const telemetry = new TelemetryReporter(clientPackageJSON.aiKey);
context.subscriptions.push(telemetry);
client = await startClient(context, newLanguageClient, { schemaRequests, telemetry, timer, logOutputChannel });
```
Supply a dummy reporter and avoid registering the real one in `context.subscriptions`.

## src/vs/platform/profiling/common/profilingTelemetrySpec.ts
```
telemetryService.publicLog2<TelemetrySampleData, TelemetrySampleDataClassification>(`unresponsive.sample`, {
    perfBaseline,
    selfTime: sample.selfTime,
    totalTime: sample.totalTime,
    percentage: sample.percentage,
    functionName: sample.location,
});
```
Override `telemetryService` with a version whose logging methods are inert.

## extensions/microsoft-authentication/src/extension.ts
```
const mainTelemetryReporter = new MicrosoftAuthenticationTelemetryReporter(context.extension.packageJSON.aiKey);
const expService = await createExperimentationService(
        context,
        mainTelemetryReporter,
        env.uriScheme !== 'vscode',
);
```
Use a reporter implementation that records nothing before calling `createExperimentationService`.
