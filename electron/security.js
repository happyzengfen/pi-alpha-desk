"use strict";

function isTrustedRendererUrl(candidate, applicationUrl) {
  try {
    const candidateUrl = new URL(candidate);
    const trustedUrl = new URL(applicationUrl);
    return candidateUrl.origin === trustedUrl.origin
      && (candidateUrl.protocol === "http:" || candidateUrl.protocol === "https:");
  } catch {
    return false;
  }
}

function isSafeExternalUrl(candidate) {
  try {
    const protocol = new URL(candidate).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function encodeFilePathForApi(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

module.exports = { encodeFilePathForApi, isSafeExternalUrl, isTrustedRendererUrl };
