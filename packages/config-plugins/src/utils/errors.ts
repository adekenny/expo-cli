export class UnexpectedError extends Error {
  readonly name = 'UnexpectedError';

  constructor(message: string) {
    super(`${message}\nPlease report this as an issue on https://github.com/expo/expo-cli/issues`);
  }
}

export type PluginErrorCode = 'INVALID_PLUGIN_TYPE';

/**
 * Based on `JsonFileError` from `@expo/json-file`
 */
export class PluginError extends Error {
  readonly name = 'PluginError';
  readonly isPluginError = true;

  constructor(message: string, public code: PluginErrorCode, public cause?: Error) {
    super(cause ? `${message}\n└─ Cause: ${cause.name}: ${cause.message}` : message);
  }
}
