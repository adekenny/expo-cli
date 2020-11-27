import { ExpoConfig, getConfig, modifyConfigAsync } from '@expo/config';
import { UserManager } from '@expo/xdl';
import got from 'got';

import CommandError, { SilentError } from '../../CommandError';
import log from '../../log';
import prompt, { confirmAsync } from '../../prompts';
import { learnMore } from '../utils/TerminalLink';
import { isUrlAvailableAsync } from '../utils/url';

const noIOSBundleIdMessage = `Your project must have a \`ios.bundleIdentifier\` set in the Expo config (app.json or app.config.js).\nSee https://expo.fyi/bundle-identifier`;
const noAndroidPackageMessage = `Your project must have a \`android.package\` set in the Expo config (app.json or app.config.js).\nSee https://expo.fyi/android-package`;

function validateBundleId(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9\-.]+$/.test(value);
}

function validatePackage(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value);
}

const cachedIOSBundleIdResults: Record<string, string> = {};
const cachedAndroidApplicationIdResults: Record<string, string> = {};

/**
 * A quality of life method that provides a warning when the bundle ID is already in use.
 */
async function getIOSBundleIdWarningAsync(iOSBundleId: string): Promise<string | null> {
  // Prevent fetching for the same ID multiple times.
  if (cachedIOSBundleIdResults[iOSBundleId]) {
    return cachedIOSBundleIdResults[iOSBundleId];
  }

  if (!(await isUrlAvailableAsync('itunes.apple.com'))) {
    // If no network, simply skip the warnings since they'll just lead to more confusion.
    return null;
  }

  const url = `http://itunes.apple.com/lookup?bundleId=${iOSBundleId}`;
  try {
    const response = await got(url);
    const json = JSON.parse(response.body?.trim());
    if (json.resultCount > 0) {
      const firstApp = json.results[0];
      const message = formatInUseWarning(firstApp.trackName, firstApp.sellerName, iOSBundleId);
      cachedIOSBundleIdResults[iOSBundleId] = message;
      return message;
    }
  } catch {
    // Error fetching itunes data.
  }
  return null;
}

async function getAndroidApplicationIdWarningAsync(
  androidApplicationId: string
): Promise<string | null> {
  // Prevent fetching for the same ID multiple times.
  if (cachedAndroidApplicationIdResults[androidApplicationId]) {
    return cachedAndroidApplicationIdResults[androidApplicationId];
  }

  if (!(await isUrlAvailableAsync('play.google.com'))) {
    // If no network, simply skip the warnings since they'll just lead to more confusion.
    return null;
  }

  const url = `https://play.google.com/store/apps/details?id=${androidApplicationId}`;
  try {
    const response = await got(url);
    // If the page exists, then warn the user.
    if (response.statusCode === 200) {
      // There is no JSON API for the Play Store so we can't concisely
      // locate the app name and developer to match the iOS warning.
      const message = `⚠️  The application ID ${log.chalk.bold(
        androidApplicationId
      )} is already in use. ${log.chalk.dim(learnMore(url))}`;
      cachedAndroidApplicationIdResults[androidApplicationId] = message;
      return message;
    }
  } catch {
    // Error fetching play store data or the page doesn't exist.
  }
  return null;
}

function formatInUseWarning(appName: string, author: string, id: string): string {
  return `⚠️  The app ${log.chalk.bold(appName)} by ${log.chalk.italic(
    author
  )} is already using ${log.chalk.bold(id)}`;
}

/**
 * Tries to read `ios.bundleIdentifier` from the application manifest.
 * It tries to obtain the value according to the following rules:
 * 1. read `ios.bundleIdentifier` and return it if present (throws upon wrong format) or upon no value 🔽
 * 2. read `android.applicationId` and use it as a suggestion for the user or upon no value 🔽
 * 3. read `android.package` and use it as a suggestion for the user or upon no value 🔽
 * 4. create `username`-based value and use it as a suggestion for the user.
 *
 * @sideEffect If there was not `ios.bundleIdentifier` in the manifest then the manifest is mutated with the user input.
 * @throws When there is a value in `ios.bundleIdentifier`, but the format of this value is incorrect.
 */
export async function getOrPromptForBundleIdentifier(projectRoot: string): Promise<string> {
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });

  const currentBundleId = exp.ios?.bundleIdentifier;
  if (currentBundleId) {
    if (validateBundleId(currentBundleId)) {
      return currentBundleId;
    }
    throw new CommandError(
      `The ios.bundleIdentifier defined in your Expo config is not formatted properly. Only alphanumeric characters, '.', '-', and '_' are allowed, and each '.' must be followed by a letter.`
    );
  }

  // Recommend a bundle ID based on the username and project slug.
  let recommendedBundleId: string | undefined;
  // Attempt to use the android package name first since it's convenient to have them aligned.
  if (exp.android?.package && validateBundleId(exp.android?.package)) {
    recommendedBundleId = exp.android?.package;
  } else {
    const username = exp.owner ?? (await UserManager.getCurrentUsernameAsync());
    const possibleId = `com.${username}.${exp.slug}`;
    if (username && validateBundleId(possibleId)) {
      recommendedBundleId = possibleId;
    }
  }

  log.addNewLineIfNone();
  log(
    `${log.chalk.bold(`📝  iOS Bundle Identifier`)} ${log.chalk.dim(
      learnMore('https://expo.fyi/bundle-identifier')
    )}`
  );
  log.newLine();
  // Prompt the user for the bundle ID.
  // Even if the project is using a dynamic config we can still
  // prompt a better error message, recommend a default value, and help the user
  // validate their custom bundle ID upfront.
  const { bundleIdentifier } = await prompt(
    {
      type: 'text',
      name: 'bundleIdentifier',
      initial: recommendedBundleId,
      // The Apple helps people know this isn't an EAS feature.
      message: `What would you like your iOS bundle identifier to be?`,
      validate: validateBundleId,
    },
    {
      nonInteractiveHelp: noIOSBundleIdMessage,
    }
  );

  // Warn the user if the bundle ID is already in use.
  const warning = await getIOSBundleIdWarningAsync(bundleIdentifier);
  if (warning) {
    log.newLine();
    log.nestedWarn(warning);
    log.newLine();
    if (
      !(await confirmAsync({
        message: `Continue?`,
        initial: true,
      }))
    ) {
      log.newLine();
      return getOrPromptForBundleIdentifier(projectRoot);
    }
  }

  // Apply the changes to the config.
  await attemptModification(
    projectRoot,
    {
      ios: { ...(exp.ios || {}), bundleIdentifier },
    },
    { ios: { bundleIdentifier } }
  );

  return bundleIdentifier;
}

/**
 * Tries to read `android.package` from the application manifest.
 * It tries to obtain the value according to the following rules:
 * 1. read `android.package` and return it if present (throws upon wrong format) or upon no value 🔽
 * 2. read `android.applicationId` and use it as a suggestion for the user or upon no value 🔽
 * 3. read `ios.bundleIdentifier` and use it as a suggestion for the user or upon no value 🔽
 * 4. create `username`-based value and use it as a suggestion for the user.
 *
 * @sideEffect If there was not `android.package` in the manifest then the manifest is mutated with the user input.
 * @throws When there is a value in `android.package`, but the format of the this value is incorrect.
 */
export async function getOrPromptForPackage(projectRoot: string): Promise<string> {
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true });

  const currentPackage = exp.android?.package;
  if (currentPackage) {
    if (validatePackage(currentPackage)) {
      return currentPackage;
    }
    throw new CommandError(
      `Invalid format of Android package name. Only alphanumeric characters, '.' and '_' are allowed, and each '.' must be followed by a letter.`
    );
  }

  // Recommend a package name based on the username and project slug.
  let recommendedPackage: string | undefined;
  // Attempt to use the ios bundle id first since it's convenient to have them aligned.
  if (exp.ios?.bundleIdentifier && validatePackage(exp.ios.bundleIdentifier)) {
    recommendedPackage = exp.ios.bundleIdentifier;
  } else {
    const username = exp.owner ?? (await UserManager.getCurrentUsernameAsync());
    // It's common to use dashes in your node project name, strip them from the suggested package name.
    const possibleId = `com.${username}.${exp.slug}`.split('-').join('');
    if (username && validatePackage(possibleId)) {
      recommendedPackage = possibleId;
    }
  }

  log.addNewLineIfNone();
  log(
    `${log.chalk.bold(`📝  Android package`)} ${log.chalk.dim(
      learnMore('https://expo.fyi/android-package')
    )}`
  );
  log.newLine();

  // Prompt the user for the android package.
  // Even if the project is using a dynamic config we can still
  // prompt a better error message, recommend a default value, and help the user
  // validate their custom android package upfront.
  const { packageName } = await prompt(
    {
      type: 'text',
      name: 'packageName',
      initial: recommendedPackage,
      message: `What would you like your Android package name to be?`,
      validate: validatePackage,
    },
    {
      nonInteractiveHelp: noAndroidPackageMessage,
    }
  );

  // Warn the user if the package name is already in use.
  const warning = await getAndroidApplicationIdWarningAsync(packageName);
  if (warning) {
    log.newLine();
    log.nestedWarn(warning);
    log.newLine();
    if (
      !(await confirmAsync({
        message: `Continue?`,
        initial: true,
      }))
    ) {
      log.newLine();
      return getOrPromptForPackage(projectRoot);
    }
  }

  // Apply the changes to the config.
  await attemptModification(
    projectRoot,
    {
      android: { ...(exp.android || {}), package: packageName },
    },
    {
      android: { package: packageName },
    }
  );

  return packageName;
}

async function attemptModification(
  projectRoot: string,
  edits: Partial<ExpoConfig>,
  exactEdits: Partial<ExpoConfig>
): Promise<void> {
  const modification = await modifyConfigAsync(projectRoot, edits, {
    skipSDKVersionRequirement: true,
  });
  if (modification.type === 'success') {
    log.newLine();
  } else {
    warnAboutConfigAndThrow(modification.type, modification.message!, exactEdits);
  }
}

function logNoConfig() {
  log(
    log.chalk.yellow(
      'No Expo config was found. Please create an Expo config (`app.config.js` or `app.json`) in your project root.'
    )
  );
}

function warnAboutConfigAndThrow(type: string, message: string, edits: Partial<ExpoConfig>) {
  log.addNewLineIfNone();
  if (type === 'warn') {
    // The project is using a dynamic config, give the user a helpful log and bail out.
    log(log.chalk.yellow(message));
  } else {
    logNoConfig();
  }

  notifyAboutManualConfigEdits(edits);
  throw new SilentError();
}

function notifyAboutManualConfigEdits(edits: Partial<ExpoConfig>) {
  log(log.chalk.cyan(`Please add the following to your Expo config, and try again... `));
  log.newLine();
  log(JSON.stringify(edits, null, 2));
  log.newLine();
}
