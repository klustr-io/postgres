#!/usr/bin/env node
// Adopted from .agents/saas_skill, commit 1747476. Kept in this repository so CI
// enforces the same source/contracts policy without a local skill installation.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const argumentsList = process.argv.slice(2);
const force = argumentsList.includes("--force");
const configIndex = argumentsList.indexOf("--config");
const configPath = path.resolve(
  ROOT,
  configIndex >= 0 && argumentsList[configIndex + 1] ? argumentsList[configIndex + 1] : ".architecture-guard.json",
);
const SOURCE_ROOTS = ["src", "source"].map((value) => path.join(ROOT, value)).filter(fs.existsSync);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const CONFIG_EXEMPTIONS = new Set([
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "eslint.config.mjs",
  "eslint.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
]);
const LEGACY_UX_ARTIFACTS = new Set();
const LEGACY_RUNTIME_ARTIFACT = /^Legacy[A-Za-z0-9]*(?:Runtime|Server)$/;
const COMPOSITION_CONTEXT_LIMIT = 12;
const COMPOSITION_CONSTRUCTION_LIMIT = 40;
const COMPOSITION_DEPENDENCY_BAG_LIMIT = 20;
const COMPOSITION_DIRECTORY_MODULE_LIMIT = 12;
const SOURCE_DIRECTORY_MODULE_LIMIT = 24;
const COMPOSITION_DEPENDENCY_BAG = /\b(?:const|let|var)\s+([a-z][A-Za-z0-9]*Dependencies)\s*=\s*\{/g;
const GENERIC_NAMES =
  /^(Utils|Helpers|Common|Manager|Services|Types|Api|Routes|Controller|Service)\.(js|jsx|mjs|cjs|ts|tsx)$/;
const BOOTSTRAP_CREATE =
  /\b(?:create|Create|make|Make|build|Build)(?:Application|HttpServer|Server|Router|ProfileProvider)\b/;
const CONCRETE_INFRA_IMPORT =
  /(?:prisma|sequelize|typeorm|mongoose|knex|redis|ioredis|kafkajs|@aws-sdk|pg|mysql|mongodb|hbase|amqplib)/i;
const DOMAIN_FORBIDDEN_IMPORT =
  /(?:react|react-router|express|fastify|hono|koa|nest|prisma|sequelize|typeorm|mongoose|redis|kafka|@aws-sdk)/i;
const EXPORTED_SYMBOL =
  /export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const)\s+([A-Za-z_$][\w$]*)/g;
const NUMBERED_ARCHITECTURE_PART =
  /(?:Part|Partition|Chunk|Segment|Section|Entries|Metrics|Adjectives)(?:\d+[A-Za-z]*|[A-Z])$/;
const BORROWED_OPERATION_DISPATCH =
  /\b[A-Z][A-Za-z0-9]*Operations\.[A-Za-z_$][A-Za-z0-9_$]*\.(?:apply|call)\(\s*this\b/g;
const PROTOTYPE_OPERATION_MIXIN =
  /Object\.assign\(\s*[A-Z][A-Za-z0-9]*\.prototype\s*,[\s\S]{0,4000}?\b[A-Z][A-Za-z0-9]*Operations\b/g;
const STATEFUL_OPERATION_BAG = /export\s+const\s+([A-Z][A-Za-z0-9]*Operations)\s*=\s*\{/g;
const GENERIC_CONTROL_PLANE_OPERATIONS = /export\s+const\s+(ControlPlane[A-Za-z0-9]*Operations)\b/g;
const EXPORTED_PROCEDURAL_OPERATIONS =
  /export\s+(?:default\s+)?(?:class|function|const)\s+([A-Z][A-Za-z0-9]*Operations)\b/g;
const BORROWED_BOUNDARY_OPERATION_FACTORY =
  /export\s+function\s+([A-Z][A-Za-z0-9]*)\s*\(\s*(?:boundary|context|host|service|store)\s*\)\s*\{[\s\S]{0,4000}?return\s+(?:Object\.freeze\(\s*)?\{/g;
const BORROWED_BOUNDARY_OPERATION_CALL = /\b([A-Z][A-Za-z0-9]*Operations)\(\s*this\s*\)/g;
const GOD_CONTEXT_CAPABILITY_ACCESS =
  /\b(?:this\.)?(?:store|controlPlaneStore|controlPlane)\.(?:stateBoundary|unitOfWork|permissionGrants|accessRequests|users|hierarchy|hierarchyPlacement|workPackages|comments|reviewActivity|resourceAdoption|resourceUsageCatalog|resourceUsageCollection|resourceUsageObservations|resourceUsageSeed|metricObservations|metricDefinitions|metricCollections|provisioningDefinitions|provisionRequests|provisionRequestAdministration|runtimeFulfillment|provisionFulfillment)\./g;
const EXPORTED_INIT_FACTORY = /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*Init)\s*\(([\s\S]*?)\)\s*\{/g;
const JSDOC_BLOCK = /\/\*\*[\s\S]*?\*\//g;
const MODULE_SPECIFIER =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
const APP_ROUTE_DECISION =
  /\b(?:taxonomy|selectedKind|productPage|projectPage|adminPage|insightPage|pathname)\s*(?:===|!==)|\b(?:taxonomy|selectedKind|productPage|projectPage|adminPage|insightPage|pathname)\b[\s\S]{0,80}?\.includes\s*\(/g;
const POSITIONAL_ROUTE_SEGMENT = /\b(?:parts|segments)\s*\[\s*\d+\s*\]/g;
const PATHNAME_ROUTE_DECISION = /\bpathname\s*(?:===|!==)|\bpathname\b[\s\S]{0,80}?\.includes\s*\(/g;
const POSITIONAL_ROUTE_ROOT =
  /(?:\b(?:parts|segments)\s*\[\s*0\s*\]\s*={2,3}\s*["']([^"']+)["']|["']([^"']+)["']\s*={2,3}\s*\b(?:parts|segments)\s*\[\s*0\s*\])/g;

const errors = [];
const warnings = [];
let configuration = {};

if (fs.existsSync(configPath)) {
  try {
    configuration = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (configuration.enabled === false && !force) {
      console.log(
        `ArchitectureCheck is disabled by ${
          path.relative(ROOT, configPath) || configPath
        }. Use --force to run it explicitly.`,
      );
      process.exit(0);
    }
    if ((configuration.route_boundary_debt || []).length)
      errors.push(`${path.relative(ROOT, configPath)}: route_boundary_debt is prohibited; fix the violations`);
    if ((configuration.source_size_debt || []).length)
      errors.push(`${path.relative(ROOT, configPath)}: source_size_debt is prohibited; decompose the source files`);
    if (Object.hasOwn(configuration, "documentation_contract_debt")) {
      errors.push(
        `${path.relative(
          ROOT,
          configPath,
        )}: documentation_contract_debt is prohibited; fix public documentation contracts`,
      );
    }
  } catch (error) {
    console.error(`ArchitectureCheck: cannot read ${path.relative(ROOT, configPath)}: ${error.message}`);
    process.exit(2);
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build", "coverage", ".next"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/^\.?[a-z0-9][a-z0-9.-]*$/.test(entry.name)) {
        errors.push(`${relative(fullPath)}: folder names must be lowercase`);
      }
      walk(fullPath);
      continue;
    }
    inspectFile(fullPath);
  }
}

function InspectCompositionDirectoryTopology(directory) {
  const directModules = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)));
  if (directModules.length > COMPOSITION_DIRECTORY_MODULE_LIMIT) {
    errors.push(
      `${relative(directory)}: architecture violation [composition-directory-sprawl] composition directory contains ${directModules.length} direct modules; limit ${COMPOSITION_DIRECTORY_MODULE_LIMIT} and group modules into lowercase capability-owned subfolders`,
    );
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    InspectCompositionDirectoryTopology(path.join(directory, entry.name));
  }
}

function InspectSourceDirectoryTopology(directory) {
  const directModules = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)));
  if (directModules.length > SOURCE_DIRECTORY_MODULE_LIMIT) {
    errors.push(
      `${relative(directory)}: architecture violation [source-directory-sprawl] source directory contains ${directModules.length} direct modules; limit ${SOURCE_DIRECTORY_MODULE_LIMIT} and group modules into lowercase domain capability or presentation-responsibility subfolders`,
    );
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (["node_modules", ".git", "dist", "build", "coverage", ".next"].includes(entry.name)) continue;
    InspectSourceDirectoryTopology(path.join(directory, entry.name));
  }
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function isPascalCaseFile(filename) {
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length).replace(/\.(?:test|spec)$/i, "");
  return /^[A-Z][A-Za-z0-9]*$/.test(stem);
}

function moduleSpecifiers(content) {
  return [...content.matchAll(MODULE_SPECIFIER)].map((match) => match[1] || match[2] || match[3]).filter(Boolean);
}

function hasJSDocBefore(content, index) {
  const prefix = content.slice(Math.max(0, index - 2400), index);
  return /\/\*\*[\s\S]*?\*\/\s*$/.test(prefix);
}

function JSDocBefore(content, index) {
  const prefix = content.slice(Math.max(0, index - 5000), index);
  const matches = [...prefix.matchAll(JSDOC_BLOCK)];
  const match = matches.at(-1);
  if (!match || prefix.slice((match.index ?? 0) + match[0].length).trim()) return "";
  return match[0];
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function CompositionDependencyBags(content) {
  const bags = [];
  for (const match of content.matchAll(COMPOSITION_DEPENDENCY_BAG)) {
    const openingBrace = (match.index ?? 0) + match[0].lastIndexOf("{");
    let depth = 1;
    let propertyCount = 0;
    let propertyHasContent = false;
    let quote = "";
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openingBrace + 1; index < content.length && depth > 0; index += 1) {
      const character = content[index];
      const next = content[index + 1];
      if (lineComment) {
        if (character === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        if (depth === 1 && !/\s/.test(character)) propertyHasContent = true;
        continue;
      }
      if (character === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (['"', "'", "`"].includes(character)) {
        quote = character;
        propertyHasContent = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0 && propertyHasContent) propertyCount += 1;
      } else if (character === "," && depth === 1) {
        if (propertyHasContent) propertyCount += 1;
        propertyHasContent = false;
      } else if (depth === 1 && !/\s/.test(character)) {
        propertyHasContent = true;
      }
    }
    bags.push({ name: match[1], propertyCount });
  }
  return bags;
}

function routeBoundaryViolation({ rule, rel, metric, limit, message }) {
  if (metric <= limit) return;
  errors.push(`${rel}: route-boundary violation [${rule}] ${message} (${metric}; limit ${limit})`);
}

function DocumentationContractViolation({ rule, rel, metric, message }) {
  if (metric < 1) return;
  errors.push(`${rel}: documentation contract violation [${rule}] ${message} (${metric})`);
}

function SourceCodeLineCount(content) {
  let output = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (character === "\n") output += "\n";
      else if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (['"', "'", "`"].includes(character)) quote = character;
    output += character;
  }
  return output.split(/\r?\n/).filter((line) => line.trim()).length;
}

function JSDocReturnType(documentation) {
  return documentation.match(/@returns?\s+\{([^}\n]+)\}/)?.[1]?.trim() ?? "";
}

function JSDocParameterTypes(documentation) {
  return [...documentation.matchAll(/@param\s+\{([^}\n]+)\}/g)].map((match) => match[1].trim());
}

function IsNamedContractType(type) {
  if (!type || /^(?:any|object|Object|Function|\*)$/.test(type) || type.includes("{")) return false;
  return /(?:^|[<|(])(?:import\([^)]*\)\.)?[A-Z][A-Za-z0-9]*(?:[>|)\[\]]|$)/.test(type);
}

function TopLevelParameterCount(parameters) {
  if (!parameters.trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const character of parameters) {
    if ("{[(".includes(character)) depth += 1;
    else if ("}])".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) count += 1;
  }
  return count;
}

function TopLevelParameters(parameters) {
  if (!parameters.trim()) return [];
  const values = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < parameters.length; index += 1) {
    const character = parameters[index];
    if ("{[(".includes(character)) depth += 1;
    else if ("}])".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      values.push(parameters.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(parameters.slice(start).trim());
  return values.filter(Boolean);
}

function FindClosingBrace(content, openingIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingIndex; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (['"', "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return content.length - 1;
}

function ExportedClassBodies(content) {
  const bodies = [];
  for (const match of content.matchAll(/export\s+class\s+[A-Z][A-Za-z0-9]*(?:\s+extends\s+[^\{]+)?\s*\{/g)) {
    const openingIndex = (match.index ?? 0) + match[0].lastIndexOf("{");
    bodies.push({
      start: openingIndex + 1,
      content: content.slice(openingIndex + 1, FindClosingBrace(content, openingIndex)),
    });
  }
  return bodies;
}

function ConstructorTypeIsValid(type, parameter) {
  if (!type || /^(?:any|object|Object|Function|\*)$/.test(type) || type.includes("{")) return false;
  if (parameter.trim().startsWith("{") || parameter.trim().startsWith("[")) return IsNamedContractType(type);
  const name = parameter.match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/)?.[1] ?? "";
  if (/(?:repository|store|provider|service|application|client|clock|fetch|idProvider)$/i.test(name)) {
    return IsNamedContractType(type);
  }
  return true;
}

function PublicMethodContractIsComplete(documentation, parameters, asynchronous) {
  if (!documentation) return false;
  const description = documentation
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .filter((line) => line.trim() && !line.trim().startsWith("@"))
    .join(" ");
  const parameterCount = TopLevelParameters(parameters).length;
  const parameterTags = [...documentation.matchAll(/@param\s+\{([^}\n]+)\}\s+\S+([^\n]*)/g)];
  const returnTag = documentation.match(/@returns?\s+\{([^}\n]+)\}([^\n]*)/);
  return (
    description.length >= 12 &&
    /authoriz|permission|administrative caller|owning application boundary/i.test(description) &&
    /side effect|persist|mutat|emit|audit|integration event|dependencies invoked/i.test(description) &&
    parameterTags.length >= parameterCount &&
    parameterTags.every((tag) => /\s+-\s+\S/.test(tag[2])) &&
    Boolean(returnTag && /\s+\S/.test(returnTag[2])) &&
    (!asynchronous || /@throws\s+\{[^}\n]+\}\s+\S/.test(documentation))
  );
}

function InspectDocumentationContracts({ rel, content, isTestArtifact }) {
  if (isTestArtifact) return;

  let missingParameterContracts = 0;
  let missingReturnContracts = 0;
  const publicDocumentation = new Set();
  for (const factory of content.matchAll(EXPORTED_INIT_FACTORY)) {
    const documentation = JSDocBefore(content, factory.index ?? 0);
    if (documentation) publicDocumentation.add(documentation);
    const parameters = factory[2].trim();
    const parameterTypes = JSDocParameterTypes(documentation);
    if (
      parameters &&
      (parameterTypes.length < TopLevelParameterCount(parameters) ||
        parameterTypes.some((type) => !IsNamedContractType(type)))
    ) {
      missingParameterContracts += 1;
    }
    const returnType = JSDocReturnType(documentation);
    if (returnType !== "void" && !IsNamedContractType(returnType)) missingReturnContracts += 1;
  }

  DocumentationContractViolation({
    rule: "named-factory-parameter-contract",
    rel,
    metric: missingParameterContracts,
    message: "public *Init factory parameters require named JSDoc contracts",
  });
  DocumentationContractViolation({
    rule: "named-factory-return-contract",
    rel,
    metric: missingReturnContracts,
    message: "public *Init factory returns require named JSDoc contracts",
  });

  let undescribedProperties = 0;
  let undocumentedMethods = 0;
  let incompletePublicMethods = 0;
  const incompletePublicMethodNames = [];
  if (/Controller\.(?:mjs|mts)$/.test(rel) && /export\s+function\s+[A-Z][A-Za-z0-9]*ControllerInit\b/.test(content)) {
    for (const method of content.matchAll(/^[ \t]{4}(?![ \t])(async\s+)?([A-Z][A-Za-z0-9]*)\s*\(([^)]*)\)\s*\{/gm)) {
      const documentation = JSDocBefore(content, method.index ?? 0);
      if (!documentation) undocumentedMethods += 1;
      else {
        publicDocumentation.add(documentation);
        if (!PublicMethodContractIsComplete(documentation, method[3], Boolean(method[1]))) {
          incompletePublicMethods += 1;
          incompletePublicMethodNames.push(method[2]);
        }
      }
    }
  }
  DocumentationContractViolation({
    rule: "documented-controller-methods",
    rel,
    metric: undocumentedMethods,
    message: "public controller methods require adjacent JSDoc",
  });

  let undocumentedClassMethods = 0;
  const exportedClassBodies = ExportedClassBodies(content);
  for (const classBody of exportedClassBodies) {
    for (const method of classBody.content.matchAll(
      /^[ \t]{2}(?![ \t])(?!(?:if|for|while|switch|catch|with)\b)(?:(?:static|async)\s+)*([A-Za-z][A-Za-z0-9]*)\s*\([^)]*\)\s*\{/gm,
    )) {
      if (method[1] === "constructor") continue;
      const documentation = JSDocBefore(content, classBody.start + (method.index ?? 0));
      if (!documentation) undocumentedClassMethods += 1;
      else {
        publicDocumentation.add(documentation);
        const parameters = method[0].slice(method[0].indexOf("(") + 1, method[0].lastIndexOf(")"));
        if (!PublicMethodContractIsComplete(documentation, parameters, /\basync\b/.test(method[0]))) {
          incompletePublicMethods += 1;
          incompletePublicMethodNames.push(method[1]);
        }
      }
    }
  }
  DocumentationContractViolation({
    rule: "documented-public-class-methods",
    rel,
    metric: undocumentedClassMethods,
    message: "public methods on exported classes require adjacent JSDoc",
  });

  let unnamedConstructorDependencies = 0;
  for (const classBody of exportedClassBodies) {
    for (const constructor of classBody.content.matchAll(/^[ \t]{2}(?![ \t])constructor\s*\(([\s\S]*?)\)\s*\{/gm)) {
      const parameters = constructor[1].trim();
      if (!parameters) continue;
      const documentation = JSDocBefore(content, classBody.start + (constructor.index ?? 0));
      if (documentation) publicDocumentation.add(documentation);
      const parameterTypes = JSDocParameterTypes(documentation);
      const parameterValues = TopLevelParameters(parameters);
      if (
        parameterTypes.length < parameterValues.length ||
        parameterValues.some((parameter, index) => !ConstructorTypeIsValid(parameterTypes[index], parameter))
      ) {
        unnamedConstructorDependencies += 1;
      }
    }
  }
  DocumentationContractViolation({
    rule: "named-constructor-parameter-contract",
    rel,
    metric: unnamedConstructorDependencies,
    message: "exported class constructors require named JSDoc dependency contracts",
  });

  let undocumentedReturnedMethods = 0;
  if (
    /export\s+function\s+[A-Z][A-Za-z0-9]*(?:Service|Provider|Repository|Store|Application)Init\b/.test(content) &&
    /return\s+Object\.freeze\s*\(\s*\{/.test(content)
  ) {
    for (const method of content.matchAll(
      /^[ \t]{4}(?![ \t])(?!(?:if|for|while|switch|catch|with)\b)(async\s+)?([A-Za-z][A-Za-z0-9]*)\s*\(([^)]*)\)\s*\{/gm,
    )) {
      const documentation = JSDocBefore(content, method.index ?? 0);
      if (!documentation) undocumentedReturnedMethods += 1;
      else {
        publicDocumentation.add(documentation);
        if (!PublicMethodContractIsComplete(documentation, method[3], Boolean(method[1]))) {
          incompletePublicMethods += 1;
          incompletePublicMethodNames.push(method[2]);
        }
      }
    }
  }
  DocumentationContractViolation({
    rule: "documented-returned-service-methods",
    rel,
    metric: undocumentedReturnedMethods,
    message: "public methods returned by service/provider factories require adjacent JSDoc",
  });
  DocumentationContractViolation({
    rule: "complete-public-method-contracts",
    rel,
    metric: incompletePublicMethods,
    message: `public methods require purpose, authorization, side effects, described parameters, a result, and async errors: ${[
      ...new Set(incompletePublicMethodNames),
    ].join(", ")}`,
  });

  for (const blockMatch of content.matchAll(JSDOC_BLOCK)) {
    const block = blockMatch[0];
    if (/@typedef\s+\{(?:object|Object)\}/.test(block)) {
      publicDocumentation.add(block);
      for (const property of block.matchAll(/@property\s+\{[^}\n]+\}\s+(?:\[[^\]]+\]|\S+)([^\n]*)/g)) {
        if (!/\s+-\s+\S/.test(property[1])) undescribedProperties += 1;
      }
    }
  }
  let broadTypes = 0;
  for (const block of publicDocumentation) {
    for (const annotation of block.matchAll(/@(?:param|property|returns?)\s+\{([^}\n]+)\}/g)) {
      const type = annotation[1].trim();
      if (/^(?:any|object|Object|Function|\*)$/.test(type) || type.includes("{")) broadTypes += 1;
    }
  }
  DocumentationContractViolation({
    rule: "documented-object-contract-properties",
    rel,
    metric: undescribedProperties,
    message: "object-shaped typedef properties require domain-oriented descriptions",
  });
  DocumentationContractViolation({
    rule: "domain-specific-jsdoc-types",
    rel,
    metric: broadTypes,
    message: "JSDoc uses object, Function, any, *, or an anonymous inline object instead of a named contract",
  });
}

function destructuredModelFieldCount(content) {
  const match = content.match(/\bconst\s*\{([\s\S]{0,12000}?)\}\s*=\s*model\s*;/);
  if (!match) return 0;
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z_$][\w$]*(?:\s*:\s*[A-Za-z_$][\w$]*)?$/.test(value)).length;
}

function domainPresentationImports(imports) {
  return new Set(
    imports.flatMap((specifier) => {
      const match = specifier.match(/(?:^|\/)domains\/([^/]+)\/presentation(?:\/|$)/);
      return match ? [match[1]] : [];
    }),
  );
}

function positionalRouteRoots(content) {
  return new Set([...content.matchAll(POSITIONAL_ROUTE_ROOT)].map((match) => match[1] ?? match[2]));
}

function inspectAppAndRouteBoundaries({ rel, filename, content, lines, imports, isTestArtifact }) {
  if (isTestArtifact) return;
  if (/^src\/App\.(?:js|jsx|ts|tsx)$/.test(rel)) {
    routeBoundaryViolation({
      rule: "thin-app-shell",
      rel,
      metric: lines,
      limit: 120,
      message: "App may only compose top-level providers, boundaries, router, and template",
    });
  }

  if (rel.startsWith("src/app/presentation/")) {
    const domainImports = domainPresentationImports(imports);
    routeBoundaryViolation({
      rule: "app-shell-domain-ownership",
      rel,
      metric: domainImports.size,
      limit: 3,
      message: `application shell imports presentation from ${domainImports.size} domains instead of composing domain-owned route modules`,
    });
    routeBoundaryViolation({
      rule: "app-shell-route-decisions",
      rel,
      metric: countMatches(content, APP_ROUTE_DECISION),
      limit: 8,
      message: "application shell contains hand-written domain/page route decisions",
    });
    routeBoundaryViolation({
      rule: "app-shell-model-bag",
      rel,
      metric: destructuredModelFieldCount(content),
      limit: 20,
      message: "application shell hides feature requirements behind one oversized model bag",
    });
  }

  if (rel.includes("/shared/presentation/") && /Route|Navigation/.test(filename)) {
    routeBoundaryViolation({
      rule: "shared-handwritten-router",
      rel,
      metric: countMatches(content, PATHNAME_ROUTE_DECISION),
      limit: 3,
      message: "shared presentation module acts as a hand-written router",
    });
  }

  const normalized = rel.toLowerCase();
  if (!normalized.includes("/api/routes/") && !normalized.includes("/api/controllers/")) return;
  routeBoundaryViolation({
    rule: "positional-route-segments",
    rel,
    metric: countMatches(content, POSITIONAL_ROUTE_SEGMENT),
    limit: 0,
    message: "REST delivery matches positional path-array indexes instead of declarative route parameters",
  });
  const routeRoots = positionalRouteRoots(content);
  routeBoundaryViolation({
    rule: "mixed-route-resource-roots",
    rel,
    metric: routeRoots.size,
    limit: 1,
    message: `REST module dispatches ${routeRoots.size} unrelated top-level resource roots`,
  });
  routeBoundaryViolation({
    rule: "procedural-route-branches",
    rel,
    metric: countMatches(content, /\bif\s*\(/g),
    limit: 10,
    message: "route/controller contains a procedural dispatch chain",
  });
  routeBoundaryViolation({
    rule: "route-error-construction",
    rel,
    metric: countMatches(content, /Object\.assign\s*\(\s*new\s+Error\b/g),
    limit: 0,
    message: "route/controller constructs transport errors instead of using typed errors and centralized mapping",
  });
  routeBoundaryViolation({
    rule: "oversized-route-module",
    rel,
    metric: lines,
    limit: 250,
    message: "route/controller exceeds the thin delivery-adapter boundary",
  });
}

function inspectFile(filePath) {
  const extension = path.extname(filePath);
  if (!SOURCE_EXTENSIONS.has(extension)) return;
  const filename = path.basename(filePath);
  const rel = relative(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = SourceCodeLineCount(content);
  const isTestArtifact = /\.(?:test|spec)\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(filename);
  const isGeneratedUiPrimitive = rel.startsWith("src/components/ui/");
  const isLegacyUxArtifact = LEGACY_UX_ARTIFACTS.has(rel) || isGeneratedUiPrimitive;
  const sourceStem = filename.slice(0, -extension.length).replace(/\.(?:test|spec)$/i, "");
  const isCompositionModule = rel.startsWith("src/app/composition/") || /(?:Runtime|Server)Init$/.test(sourceStem);

  if (!isTestArtifact && LEGACY_RUNTIME_ARTIFACT.test(sourceStem)) {
    errors.push(
      `${rel}: architecture violation [legacy-runtime-artifact] legacy god runtimes are prohibited; preserve compatibility at a stable facade and compose cohesive *Init stages with explicit dependencies`,
    );
  }

  if (!isTestArtifact && isCompositionModule) {
    const boundedContexts = new Set(
      moduleSpecifiers(content).flatMap((specifier) => {
        const match = specifier.match(/(?:^|\/)domains\/([^/]+)/);
        return match ? [match[1]] : [];
      }),
    );
    if (boundedContexts.size > COMPOSITION_CONTEXT_LIMIT) {
      errors.push(
        `${rel}: architecture violation [composition-context-sprawl] composition spans ${boundedContexts.size} bounded contexts; limit ${COMPOSITION_CONTEXT_LIMIT} and delegate cohesive domain runtime assembly to focused *Init modules`,
      );
    }
    const constructions =
      countMatches(content, /\bnew\s+[A-Z][A-Za-z0-9]*/g) + countMatches(content, /\b[A-Z][A-Za-z0-9]*Init\s*\(/g);
    if (constructions > COMPOSITION_CONSTRUCTION_LIMIT) {
      errors.push(
        `${rel}: architecture violation [composition-construction-sprawl] composition performs ${constructions} constructions/initializer calls; limit ${COMPOSITION_CONSTRUCTION_LIMIT} and use an explicit ordered composition chain of focused stages`,
      );
    }
    for (const dependencyBag of CompositionDependencyBags(content)) {
      if (dependencyBag.propertyCount <= COMPOSITION_DEPENDENCY_BAG_LIMIT) continue;
      errors.push(
        `${rel}: architecture violation [composition-service-locator] ${dependencyBag.name} exposes ${dependencyBag.propertyCount} capabilities; limit ${COMPOSITION_DEPENDENCY_BAG_LIMIT} and inject bounded domain-specific contracts instead of a process-wide dependency bag`,
      );
    }
  }

  if (NUMBERED_ARCHITECTURE_PART.test(sourceStem)) {
    errors.push(
      `${rel}: architecture violation [semantic-boundary-name] numbered partitions are prohibited; name the aggregate, capability, use case, policy, provider, or adapter responsibility`,
    );
  }

  if (!CONFIG_EXEMPTIONS.has(filename) && !isLegacyUxArtifact && !isPascalCaseFile(filename)) {
    errors.push(`${rel}: source filename must be PascalCase`);
  }
  if (GENERIC_NAMES.test(filename)) errors.push(`${rel}: generic dumping-ground filename`);
  // Production artifacts stay deliberately small. Characterization suites may
  // exceed the production boundary while they protect a multi-slice migration;
  // they are still subject to naming, dependency, and exported-contract rules.
  if (!isTestArtifact && !isLegacyUxArtifact && lines > 500) {
    errors.push(`${rel}: source file exceeds 500 lines (${lines}; limit 500)`);
  }
  const exportedSymbols = [...content.matchAll(EXPORTED_SYMBOL)];
  const borrowedDispatches = countMatches(content, BORROWED_OPERATION_DISPATCH);
  if (borrowedDispatches > 0) {
    errors.push(
      `${rel}: architecture violation [borrowed-operation-dispatch] ${borrowedDispatches} method(s) borrow a host instance through Operations.apply/call; inject an aggregate, application service, policy, repository, gateway, or adapter collaborator with an explicit contract`,
    );
  }
  const prototypeMixins = countMatches(content, PROTOTYPE_OPERATION_MIXIN);
  if (prototypeMixins > 0) {
    errors.push(
      `${rel}: architecture violation [prototype-operation-mixin] runtime prototype composition from operation bags is prohibited; compose explicit aggregate repositories and application collaborators instead`,
    );
  }
  for (const operationBag of content.matchAll(STATEFUL_OPERATION_BAG)) {
    const operationBody = content.slice((operationBag.index ?? 0) + operationBag[0].length);
    if (!/\bthis\s*\./.test(operationBody)) continue;
    errors.push(
      `${rel}: architecture violation [stateful-operation-bag] '${operationBag[1]}' depends on a borrowed runtime this-context; model it as an application service, repository, policy, gateway, or aggregate collaborator with explicit constructor dependencies`,
    );
  }
  for (const operationFacade of content.matchAll(GENERIC_CONTROL_PLANE_OPERATIONS)) {
    errors.push(
      `${rel}: architecture violation [generic-control-plane-operations] '${operationFacade[1]}' is a horizontal operation facade; expose aggregate repositories, application services, commands, queries, policies, or gateways owned by one bounded context`,
    );
  }
  for (const operationArtifact of content.matchAll(EXPORTED_PROCEDURAL_OPERATIONS)) {
    if (operationArtifact[1].startsWith("ControlPlane")) continue;
    errors.push(
      `${rel}: architecture violation [procedural-operation-artifact] '${operationArtifact[1]}' describes a bag of procedures instead of one aggregate, repository, application service, command, query, policy, gateway, or adapter`,
    );
  }
  for (const operationFactory of content.matchAll(BORROWED_BOUNDARY_OPERATION_FACTORY)) {
    errors.push(
      `${rel}: architecture violation [borrowed-boundary-operation-factory] '${operationFactory[1]}' accepts an entire host boundary; construct a semantic collaborator from explicit narrow dependencies`,
    );
  }
  const borrowedBoundaryCalls = countMatches(content, BORROWED_BOUNDARY_OPERATION_CALL);
  if (borrowedBoundaryCalls > 0) {
    errors.push(
      `${rel}: architecture violation [borrowed-boundary-operation-call] ${borrowedBoundaryCalls} operation dispatch(es) pass this as a hidden god-context; construct and inject a semantic collaborator instead`,
    );
  }
  if (!isTestArtifact && !isCompositionModule && !/\/ControlPlaneStore\.(?:mjs|mts)$/.test(rel)) {
    const godContextAccesses = countMatches(content, GOD_CONTEXT_CAPABILITY_ACCESS);
    if (godContextAccesses > 0) {
      errors.push(
        `${rel}: architecture violation [god-context-capability-access] ${godContextAccesses} capability access(es) are discovered through a broad store/control-plane context; inject each required repository, application service, query, command, policy, or gateway as a named dependency`,
      );
    }
  }
  if (exportedSymbols.some((match) => BOOTSTRAP_CREATE.test(match[1])))
    errors.push(`${rel}: bootstrap/composition must use *Init naming`);

  const normalized = rel.toLowerCase();
  const imports = moduleSpecifiers(content);
  const runtimeImports = moduleSpecifiers(content.replace(JSDOC_BLOCK, ''));
  if (normalized.includes('/application/') && runtimeImports.some(specifier =>
    /(?:^|\/)(?:infrastructure|composition|api|presentation)\//i.test(specifier) ||
    /^(?:node:)?(?:fs|fs\/promises|http|https|net|tls)$/.test(specifier) || CONCRETE_INFRA_IMPORT.test(specifier))) {
    errors.push(`${rel}: architecture violation [application-infrastructure-dependency] application behavior must depend on explicit provider ports rather than concrete infrastructure, transport or filesystem adapters`);
  }
  inspectAppAndRouteBoundaries({ rel, filename, content, lines, imports, isTestArtifact });
  InspectDocumentationContracts({ rel, content, isTestArtifact });
  if (normalized.includes("/domain/") && imports.some((specifier) => DOMAIN_FORBIDDEN_IMPORT.test(specifier))) {
    errors.push(`${rel}: domain imports framework or infrastructure dependency`);
  }
  if (
    (normalized.includes("/presentation/") || normalized.endsWith(".tsx")) &&
    imports.some((specifier) => CONCRETE_INFRA_IMPORT.test(specifier))
  ) {
    errors.push(`${rel}: presentation imports concrete infrastructure`);
  }
  if (
    (normalized.includes("/api/routes/") || normalized.includes("/api/controllers/")) &&
    imports.some((specifier) => CONCRETE_INFRA_IMPORT.test(specifier))
  ) {
    errors.push(`${rel}: REST route/controller imports concrete infrastructure`);
  }
  if (normalized.includes("/domain/") && /\bPartial\s*</.test(content)) {
    errors.push(`${rel}: domain mutation must not use Partial<T>`);
  }
  if (normalized.includes("/domain/") && /\bset[A-Z]\w*\s*\(/.test(content)) {
    warnings.push(`${rel}: setter-style domain method requires review`);
  }

  for (const match of exportedSymbols) {
    if (isLegacyUxArtifact) continue;
    const symbol = match[1];
    if (NUMBERED_ARCHITECTURE_PART.test(symbol)) {
      errors.push(
        `${rel}: architecture violation [semantic-boundary-name] exported symbol '${symbol}' is a numbered partition instead of a domain responsibility`,
      );
    }
    const reactHook = /^use[A-Z][A-Za-z0-9]*$/.test(symbol);
    if (!reactHook && !/^[A-Z][A-Za-z0-9]*$/.test(symbol)) {
      errors.push(`${rel}: exported architectural symbol '${symbol}' must be PascalCase`);
    }
    if (!hasJSDocBefore(content, match.index ?? 0)) {
      errors.push(`${rel}: exported symbol '${symbol}' requires JSDoc`);
    }
  }
}

if (SOURCE_ROOTS.length === 0) {
  console.error("ArchitectureCheck: no src/ or source/ directory found");
  process.exit(2);
}

for (const sourceRoot of SOURCE_ROOTS) {
  InspectSourceDirectoryTopology(sourceRoot);
  const compositionRoot = path.join(sourceRoot, "app", "composition");
  if (fs.existsSync(compositionRoot)) InspectCompositionDirectoryTopology(compositionRoot);
  walk(sourceRoot);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(`ERROR ${error}`);

if (errors.length > 0) {
  console.error(`ArchitectureCheck failed with ${errors.length} error(s) and ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`ArchitectureCheck passed with ${warnings.length} warning(s).`);
