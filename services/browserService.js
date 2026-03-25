import { chromium } from "playwright";
const BROWSER_LAUNCH_RETRIES = Math.max(1, Number(process.env.BROWSER_LAUNCH_RETRIES) || 3);
const BROWSER_LAUNCH_RETRY_DELAY_MS = Math.max(
  100,
  Number(process.env.BROWSER_LAUNCH_RETRY_DELAY_MS) || 500
);
let serverlessExecutablePathPromise = null;

function isServerlessRuntime() {
  return (
    process.env.VERCEL === "1" ||
    process.env.AWS_REGION ||
    process.env.AWS_LAMBDA_FUNCTION_NAME
  );
}

function shouldUseServerlessChromium() {
  if (process.env.PLAYWRIGHT_USE_SERVERLESS_CHROMIUM === "1") {
    return true;
  }

  if (process.env.PLAYWRIGHT_USE_SERVERLESS_CHROMIUM === "0") {
    return false;
  }

  return isServerlessRuntime();
}

export async function launchBrowser() {
  if (!shouldUseServerlessChromium()) {
    return chromium.launch({ headless: true });
  }

  let chromiumForServerless;
  try {
    const mod = await import("@sparticuz/chromium");
    chromiumForServerless = mod.default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Serverless Chromium is required but '@sparticuz/chromium' is unavailable. " +
        "Install it in server dependencies. Root cause: " +
        message
    );
  }

  chromiumForServerless.setGraphicsMode = false;
  if (!serverlessExecutablePathPromise) {
    serverlessExecutablePathPromise = chromiumForServerless.executablePath();
  }
  const executablePath = await serverlessExecutablePathPromise;

  let lastError = null;
  for (let attempt = 1; attempt <= BROWSER_LAUNCH_RETRIES; attempt += 1) {
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
        args: chromiumForServerless.args
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /ETXTBSY|text file busy|spawn/i.test(message);

      if (!retryable || attempt === BROWSER_LAUNCH_RETRIES) {
        break;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, BROWSER_LAUNCH_RETRY_DELAY_MS * attempt)
      );
    }
  }

  throw lastError;
}
