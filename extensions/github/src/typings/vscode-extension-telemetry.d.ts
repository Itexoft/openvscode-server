declare module '@vscode/extension-telemetry' {
  class TelemetryReporter {
    constructor(...args: any[]);
    sendTelemetryEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
    sendTelemetryErrorEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>): void;
    dispose(): void | Promise<void>;
  }
  export { TelemetryReporter };
  export default TelemetryReporter;
}
