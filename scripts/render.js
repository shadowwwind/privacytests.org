// imports
const fs = require('fs');
const path = require('path');
const fileUrl = require('file-url');
const open = require('open');
const minimist = require('minimist');
const template = require('./template.js');
const _ = require('lodash');
const { readYAMLFile } = require('./utils');

const escapeHtml = str => str.replace(/[&<>'"]/g,
  tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag]));

// The names used by browser-logos for nightly browsers.
const nightlyIconNames = {
  brave: "brave-nightly",
  chrome: "chrome-canary",
  duckduckgo: "duckduckgo",
  edge: "edge-canary",
  firefox: "firefox-nightly",
  opera: "opera-developer",
  safari: "safari-technology-preview",
  tor: "tor-nightly",
  vivaldi: "vivaldi-snapshot",
};

// Returns a data: URI browser logo for the given browser.
const browserLogoDataUri = _.memoize((browserName, nightly) => {
  const browserIconName = nightly ? nightlyIconNames[browserName] : browserName;
  let iconUri;
  try {
    iconUri = template.dataUriFromFile(`node_modules/browser-logos/src/${browserIconName}/${browserIconName}_128x128.png`);
    return iconUri;
  } catch (e) {
    return template.dataUriFromFile(`../assets/icons/${browserIconName}.png`);
  }
});

// Deep-copy a JSON structure (by value)
const deepCopy = (json) => JSON.parse(JSON.stringify(json));

// An HTML table with styling
const htmlTable = ({ headers, body, className }) => {
  elements = [];
  elements.push(`<table class="${className}">`);
  elements.push("<tr>");
  if (headers) {
    for (let header of headers) {
      elements.push(`<th class="table-header" style="text-transform: capitalize;">${header}</th>`);
    }
  }
  elements.push("</tr>");
  let firstSubheading = true;
  for (let row of body) {
    elements.push("<tr>");
    for (let item of row) {
      if (item.subheading) {
        let description = (item.description ?? "").replaceAll(/\s+/g, " ").trim();
        className = firstSubheading ? "first subheading" : "subheading";
        elements.push(`
        <th colspan="8" class="${className} tooltipParent">
          <div>
            <span class="subheading-title">${escapeHtml(item.subheading)}</span>
            <span class="tagline">${item.tagline}</span>
          </div>
          <span class="tooltipText">${escapeHtml(description)}</span>
        </th>`);
        firstSubheading = false;
      } else {
        elements.push(`<td>${item}</td>`);
      }
    }
    elements.push("</tr>");
  }
  elements.push("</table>");
  return elements.join("");
};

const dropMicroVersion = (version) =>
  version ? version.split(".").slice(0, 2).join(".") : version;

// An inline script that shows a tooltip if the user clicks on any table element
const tooltipScript = `
  const table = document.querySelector(".comparison-table");
  let visibleTooltip = null;
  const hide = () => {
    if (visibleTooltip) {
      visibleTooltip.style.display = "none";
      visibleTooltip.parentElement.style.backgroundColor = "";
      visibleTooltip = null;
    }
  }
  const show = (tooltip) => {
    hide();
    const viewportWidth = document.documentElement.clientWidth;
    tooltip.style.display = "block";
    tooltip.parentElement.style.backgroundColor = "#ffa";
    const tooltipRight = tooltip.getClientRects()[0].right;
    const tableRight = table.getClientRects()[0].right;
    const overflowX = tooltipRight- tableRight + 8;
    if (overflowX > 0) {
      tooltip.style.transform="translate(" + (-overflowX) +"px, 0px)";
    }
    visibleTooltip = tooltip;
  }
  document.addEventListener("mousedown", e => {
    const tooltipParent = e.composedPath().filter(element => element.classList?.contains("tooltipParent"))[0];
    if (tooltipParent) {
      const tooltip = tooltipParent.querySelector(".tooltipText");
      if (tooltip) {
        tooltip === visibleTooltip ? hide() : show(tooltip);
      }
    } else if (e.target.classList.contains("tooltipText")) {
      hide();
    } else {
      hide();
    }
  });
  //document.addEventListener("scroll", hide);
`;

// Takes the results for tests on a specific browser,
// and returns an HTML fragment that will serve as
// the header for the column showing thoses tests.
const resultsToDescription = ({
  browser,
  reportedVersion,
  os, os_version,
  prefs, incognito, tor, nightly
}) => {
  let browserFinal = browser;
  let browserVersionLong = reportedVersion;
  let browserVersionShort = dropMicroVersion(browserVersionLong) || "???";
  let platformFinal = os;
  //  let platformVersionFinal = platformVersion || "";
  let finalText = `
  <span>
    <img class="browser-logo-image" src="${browserLogoDataUri(browser, nightly)}" width="32" height="32"><br>
    ${browserFinal}<br>
    ${browserVersionShort}
  </span>`;
  if (prefs) {
    for (let key of Object.keys(prefs).sort()) {
      if (key !== "extensions.torlauncher.prompt_at_startup") {
        finalText += `<br>${key}: ${prefs[key]}`;
      }
    }
  }
  if (incognito === true) {
    finalText += "<br>private";
  }
  if (tor === true) {
    finalText += "<br>Tor";
  }
  return finalText;
};

const allHaveValue = (x, value) => {
  return Array.isArray(x) ? x.every(item => item === value) : x === value;
};

// Generates a table cell which indicates whether
// a test passed, and includes the tooltip with
// more information.
const testBody = ({ passed, testFailed, tooltip, unsupported }) => {
  let allTestsFailed = allHaveValue(testFailed, true);
  let allUnsupported = allHaveValue(unsupported, true);
  let anyDidntPass = Array.isArray(passed) ? passed.some(x => x === false) : (passed === false);
  return `<div class='dataPoint tooltipParent ${(allUnsupported) ? "na" : (anyDidntPass ? "bad" : "good")}'
> ${allUnsupported ? "&ndash;" : "&nbsp;"}
<span class="tooltipText">${escapeHtml(tooltip)}</span>
</div>`;
};

const tooltipFunctions = {};

// Creates a tooltip with fingerprinting test results
// including the test expressions, the actual
// and desired values, and whether the test passed.
tooltipFunctions["fingerprinting"] = fingerprintingItem => {
  let { expression, desired_expression, actual_value,
    desired_value, passed, worker } = fingerprintingItem;
  return `
expression: ${expression}
desired expression: ${desired_expression}
actual value: ${actual_value}
desired value: ${desired_value}
passed: ${passed}
${worker ? "[Worker]" : ""}
  `.trim();
};

// For simple tests, creates a tooltip that shows detailed results.
tooltipFunctions["simple"] = (result) => {
  let text = "";
  for (let key in result) {
    if (key !== "description") {
      text += `${key}: ${result[key]}\n`;
    }
  }
  return text.trim();
};

const joinIfArray = x => Array.isArray(x) ? x.join(", ") : x;

tooltipFunctions["crossSite"] = (
  { write, read, readSameFirstParty, readDifferentFirstParty, passed, testFailed, unsupported }
) => {
  return `
write: ${write}

read: ${read}

result, same first party: ${joinIfArray(readSameFirstParty)}

result, different first party: ${joinIfArray(readDifferentFirstParty)}

unsupported: ${joinIfArray(unsupported)}

passed: ${joinIfArray(passed)}

test failed: ${joinIfArray(testFailed)}
`.trim();
};

const resultsSection = ({ bestResults, category, tooltipFunction }) => {
  //  console.log(results);
  let section = [];
  let bestResultsForCategory = bestResults[0]["testResults"][category];
  if (!bestResultsForCategory) {
    return [];
  }
  let rowNames = Object.keys(bestResultsForCategory)
    .sort(Intl.Collator().compare);
  let resultMaps = bestResults
    .map(m => m["testResults"][category]);
  for (let rowName of rowNames) {
    let row = [];
    let description = bestResultsForCategory[rowName]["description"] ?? "";
    row.push(`<div class="tooltipParent">${rowName}<span class="tooltipText">${description}</span></div>`);
    for (let resultMap of resultMaps) {
      try {
        let tooltip = tooltipFunction(resultMap[rowName]);
        let { passed, testFailed, unsupported } = resultMap[rowName];
        row.push(testBody({ passed, testFailed, tooltip, unsupported }));
      } catch (e) {
        console.log(e, category, rowName, resultMap, resultMap[rowName]);
        throw e;
      }
    }
    section.push(row);
  }
  return section;
};

const resultsToTable = (results, title, subtitle, includeTrackingCookies) => {
  console.log(results);
  let bestResults = results
    .filter(m => m["testResults"])
    //  .filter(m => m["testResults"]["supercookies"])
    .sort((m1, m2) => m1["browser"] ? m1["browser"].localeCompare(m2["browser"]) : -1);
  console.log(bestResults[0]);
  let headers = bestResults.map(resultsToDescription);
  headers.unshift(`<h1 class="title">${title}</h1><span class="subtitle">${subtitle}</span>`);
  let body = [];
  if (bestResults.length === 0) {
    return [];
  }
  const sections = readYAMLFile('../assets/copy/sections.yaml')
  for (const { category, name, description, tagline, tooltipType } of sections) {
    if (includeTrackingCookies || !(category == "tracker_cookies")) {
      body.push([{ subheading: name, description, tagline }]);
      body = body.concat(resultsSection({
        bestResults, category,
        tooltipFunction: tooltipFunctions[tooltipType]
      }));
    }
  }
  return { headers, body };
};

// Create the title HTML for a results table.
const tableTitleHTML = (title) => `
  <div class="table-title">${title}</div>`;

// Create dateString from the given date and time string.
const dateString = (dateTime) => {
  let dateTimeObject = new Date(dateTime);
  return dateTimeObject.toISOString().split("T")[0];
};

// Creates the content for a page.
const content = (results, jsonFilename, title, nightly, incognito) => {
  let { headers, body } = resultsToTable(results.all_tests, tableTitleHTML(title), "(default settings)",results.platform === "Desktop");
  const issueNumberExists = fs.existsSync(`${__dirname}/issue-number`);
  const issueNumber = issueNumberExists ? fs.readFileSync(`${__dirname}/issue-number`).toString().trim() : undefined;
  const leftHeaderText = issueNumber ? `No. ${issueNumber}` : "";
  console.log(results.platform);
  return `
    <div class="banner" id="issueBanner">
      <div class="left-heading">${leftHeaderText}</div>
      <div class="middle-heading">Open-source tests of web browser privacy.</div>
      <div class="right-heading">Updated ${results.timeStarted ? dateString(results.timeStarted) : "??"}</div>
    </div>
    <div class="banner" id="navBanner">
      <div class="navItem ${!incognito && !nightly && results.platform !== "Android" && results.platform !== "iOS" ? "selectedItem" : ""}">
        <a href=".">Desktop browsers</a>
      </div>
      <div class="navItem ${incognito && !nightly && results.platform !== "Android" && results.platform !== "iOS" ? "selectedItem" : ""}">
        <a href="private.html">Desktop private modes</a>
      </div>
      <div class="navItem ${results.platform === "iOS" ? "selectedItem" : ""}">
        <a href="ios.html">iOS browsers</a>
      </div>
      <div class="navItem ${results.platform === "Android" ? "selectedItem" : ""}">
        <a href="android.html">Android browsers</a>
      </div>
      <div class="navItem ${nightly && !incognito ? "selectedItem" : ""}">
        <a href="nightly.html">Nightly builds</a>
      </div>
      <div class="navItem ${nightly && incognito ? "selectedItem" : ""}">
        <a href="nightly-private.html">Nightly private modes</a>
      </div>
    </div>
    <div class="banner" id="legend">
      <div id="key">
        <div><span class="marker good">&nbsp;</span>= Passed privacy test</div>
        <div><span class="marker bad">&nbsp;</span>= Failed privacy test</div>
        <div><span class="marker na">–</span>= No such feature</div>
      </div>
      <div class="banner" id="instructions">
        <div><span class="click-anywhere">(Click anywhere for more info.)</span></div>
      </div>
    </div>` +
    htmlTable({
      headers, body,
      className: "comparison-table"
    }) +
    `<p class="footer">Tests ran at ${results.timeStarted ? results.timeStarted.replace("T", " ").replace(/\.[0-9]{0,3}Z/, " UTC") : "??"}.
         Source version: <a href="https://github.com/privacytests/privacytests.org/tree/${results.git}"
    >${results.git.slice(0, 8)}</a>.
    Raw data in <a href="${jsonFilename}">JSON</a>.
    </p>` + `<script type="module">${tooltipScript}</script>`;
};

const contentPage = ({ results, title, basename, previewImageUrl, tableTitle, nightly, incognito }) =>
  template.htmlPage({
    title, previewImageUrl,
    cssFiles: [`${__dirname}/../assets/css/template.css`, `${__dirname}/../assets/css/table.css`],
    content: content(results, basename, tableTitle, nightly, incognito),
  });

// Reads in a file and parses it to a JSON object.
const readJSONFile = (file) =>
  JSON.parse(fs.readFileSync(file));

// Returns the path to the latest results file in
// the given directory.
const latestResultsFile = (dir) => {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  const stem = files
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .pop();
  const todayPath = dir + "/" + stem;
  console.log(todayPath);
  const todayFiles = fs.readdirSync(todayPath);
  const latestFile = todayFiles.filter(d => d.endsWith(".json")).sort().pop();
  return todayPath + "/" + latestFile;
};

// List of results keys that should be collected in an array
const resultsKeys = [
  "passed", "testFailed",
  "readSameFirstParty", "readDifferentFirstParty",
  "actual_value", "desired_value",
  "IsTorExit", "cloudflareDoH", "nextDoH", "result",
  "unsupported", "upgraded", "cookieFound"
];

// Finds any repeated trials of tests and aggregate the results
// for a simpler rendering.
const aggregateRepeatedTrials = (results) => {
  let aggregatedResults = new Map();
  let testIndex = 0;
  for (let test of results.all_tests) {
    if (test && test.testResults) {
      let key = resultsToDescription(test);
      //console.log(key);
      if (aggregatedResults.has(key)) {
        let theseTestResults = aggregatedResults.get(key).testResults;
        if (theseTestResults) {
          for (let subcategory of ["supercookies", "fingerprinting", "https", "misc", "navigation",
            "query", "trackers", "tracker_cookies"]) {
            let someTests = theseTestResults[subcategory];
            for (let testName in test.testResults[subcategory]) {
              for (let value in test.testResults[subcategory][testName]) {
                if (resultsKeys.includes(value)) {
                  if (!someTests[testName]) {
                    throw new Error(`Can't find the "${testName}" ${subcategory} test in testing round ${testIndex}`);
                  }
                  if (!Array.isArray(someTests[testName][value])) {
                    someTests[testName][value] = [someTests[testName][value]];
                  }
                  someTests[testName][value].push(test.testResults[subcategory][testName][value]);
                }
              }
            }
          }
        }
      } else {
        aggregatedResults.set(key, deepCopy(test));
      }
    }
    ++testIndex;
  }
  let resultsCopy = deepCopy(results);
  resultsCopy.all_tests = [...aggregatedResults.values()];
  return resultsCopy;
};

const getMergedResults = (dataFiles) => {
  let resultItems = dataFiles.map(readJSONFile);
  let finalResults = resultItems[0];
  for (let resultItem of resultItems.slice(1)) {
    finalResults.all_tests = finalResults.all_tests.concat(resultItem.all_tests);
  }
  return finalResults;
}

const renderPage = ({ dataFiles, live, aggregate }) => {
  let resultsFilesJSON = (dataFiles && dataFiles.length > 0) ? dataFiles : [latestResultsFile("../results")];
  console.log(resultsFilesJSON);
  const resultsFileHTMLLatest = "../results/latest.html";
  const resultsFileHTML = resultsFilesJSON[0].replace(/\.json$/, ".html");
  const resultsFilePreviewImage = resultsFileHTML.replace(".html", "-preview.png");
  //  fs.copyFile(resultsFile, "../results/" + path.basename(resultsFile), fs.constants.COPYFILE_EXCL);
  console.log(`Reading from raw results files: ${resultsFilesJSON}`);
  let results = getMergedResults(resultsFilesJSON);
  console.log(results.all_tests.length);
  let processedResults = aggregate ? aggregateRepeatedTrials(results) : results;
  //  console.log(results.all_tests[0]);
  //  console.log(JSON.stringify(results));
  const nightly = results.all_tests.every(t => (t.nightly === true));
  const incognito = results.all_tests.every(t => (t.incognito === true || t.tor === true));
  let tableTitle;
  if (nightly) {
    tableTitle = incognito ? "Nightly private modes" : "Nightly Builds";
  } else if (results.platform === "Android") {
    tableTitle = "Android Browsers";
  } else if (results.platform === "iOS") {
    tableTitle = "iOS Browsers";
  } else {
    tableTitle = incognito ? "Desktop private modes" : "Desktop Browsers";
  }
  const basename = path.basename(resultsFilesJSON[0]);
  fs.writeFileSync(resultsFileHTMLLatest, contentPage({
    title: "PrivacyTests.org",
    tableTitle, nightly, incognito, basename,
    results: processedResults,
    previewImageUrl: path.basename(resultsFilePreviewImage)
  }));
  console.log(`Wrote out ${fileUrl(resultsFileHTMLLatest)}`);
  fs.copyFileSync(resultsFileHTMLLatest, resultsFileHTML);
  console.log(`Wrote out ${fileUrl(resultsFileHTML)}`);
  return { resultsFileHTML, resultsFilePreviewImage };
};

const render = async ({ dataFiles, live, aggregate }) => {
  const { resultsFileHTML, resultsFilePreviewImage } = renderPage({ dataFiles, live, aggregate });
  const createPreviewImage = (await import('./preview.mjs')).createPreviewImage;
  await createPreviewImage(resultsFileHTML, resultsFilePreviewImage);
  if (!live) {
    open(fileUrl(resultsFileHTML));
  }
}

const main = async () => {
  let { _: dataFiles, live, aggregate } = minimist(process.argv.slice(2),
    opts = { default: { aggregate: true } });
  await render({ dataFiles, live, aggregate: (aggregate === true) });
};

if (require.main === module) {
  main();
}

module.exports = { render, contentPage };