import { chromium } from "playwright";

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
  const executablePath = await chromiumForServerless.executablePath();

  return chromium.launch({
    headless: true,
    executablePath,
    args: chromiumForServerless.args
  });
}

