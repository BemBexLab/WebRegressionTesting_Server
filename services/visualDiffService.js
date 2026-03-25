import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

function normalizeImage(img, width, height) {
  if (img.width === width && img.height === height) {
    return img;
  }

  const resized = new PNG({ width, height });
  PNG.bitblt(img, resized, 0, 0, img.width, img.height, 0, 0);
  return resized;
}

function getVisualStatus(mismatchPercentage, thresholdPercentage) {
  if (mismatchPercentage <= thresholdPercentage) {
    return "Pass";
  }

  if (mismatchPercentage <= thresholdPercentage * 2) {
    return "Warning";
  }

  return "Critical";
}

export function compareImages(baselineBuffer, currentBuffer, options = {}) {
  const { threshold = 0.1, mismatchThresholdPercentage = 0.3 } = options;

  const baseline = PNG.sync.read(baselineBuffer);
  const current = PNG.sync.read(currentBuffer);

  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);

  const normalizedBaseline = normalizeImage(baseline, width, height);
  const normalizedCurrent = normalizeImage(current, width, height);
  const diff = new PNG({ width, height });

  const mismatchPixels = pixelmatch(
    normalizedBaseline.data,
    normalizedCurrent.data,
    diff.data,
    width,
    height,
    { threshold }
  );

  const diffBuffer = PNG.sync.write(diff);

  const totalPixels = width * height;
  const mismatchPercentage = Number(((mismatchPixels / totalPixels) * 100).toFixed(4));

  return {
    mismatchPixels,
    totalPixels,
    mismatchPercentage,
    status: getVisualStatus(mismatchPercentage, mismatchThresholdPercentage),
    diffBuffer
  };
}
