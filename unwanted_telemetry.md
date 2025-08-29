src/vs/platform/telemetry/common/1dsAppender.ts
Отправка данных в Microsoft OneCollector через endpoint.
```ts
const endpointUrl = 'https://mobile.events.data.microsoft.com/OneCollector/1.0';
aiClient.track({
        name,
        baseData: { name, properties: data?.properties, measurements: data?.measurements }
});
```


extensions/github/src/extension.ts
Отправка телеметрии о расширении GitHub при активации.
```ts
const { aiKey } = context.extension.packageJSON as { aiKey: string };
const telemetryReporter = new TelemetryReporter(aiKey);
disposables.push(telemetryReporter);
```


extensions/markdown-language-features/src/telemetryReporter.ts
Репортёр телеметрии для расширения Markdown.
```ts
class ExtensionReporter implements TelemetryReporter {
        private readonly _reporter: VSCodeTelemetryReporter;
        constructor(
                packageInfo: IPackageInfo
        ) {
                this._reporter = new VSCodeTelemetryReporter(packageInfo.aiKey);
        }
}
```


extensions/git/src/main.ts
Инициализация TelemetryReporter для расширения Git.
```ts
import TelemetryReporter from '@vscode/extension-telemetry';
async function createModel(context: ExtensionContext, logger: LogOutputChannel, telemetryReporter: TelemetryReporter, disposables: Disposable[]): Promise<Model> {
        const model = new Model(git, askpass, context.globalState, context.workspaceState, logger, telemetryReporter);
```


extensions/json-language-features/client/src/node/jsonClientMain.ts
Отправка телеметрии в JSON language сервере.
```ts
const telemetry = new TelemetryReporter(clientPackageJSON.aiKey);
context.subscriptions.push(telemetry);
client = await startClient(context, newLanguageClient, { schemaRequests, telemetry, timer, logOutputChannel });
```


src/vs/platform/profiling/common/profilingTelemetrySpec.ts
Отправка данных о долгих вызовах.
```ts
telemetryService.publicLog2<TelemetrySampleData, TelemetrySampleDataClassification>(`unresponsive.sample`, {
        perfBaseline,
        selfTime: sample.selfTime,
        totalTime: sample.totalTime,
        percentage: sample.percentage,
        functionName: sample.location,
});
```


extensions/microsoft-authentication/src/extension.ts
Репортёр телеметрии для Microsoft Authentication.
```ts
const mainTelemetryReporter = new MicrosoftAuthenticationTelemetryReporter(context.extension.packageJSON.aiKey);
const expService = await createExperimentationService(
        context,
        mainTelemetryReporter,
        env.uriScheme !== 'vscode',
);
```
