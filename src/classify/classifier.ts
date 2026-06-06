import type {
  Classification,
  JsonObject,
  JsonValue,
  RiskLabel,
  ToolMetadata,
} from "../domain/types.js";

const RISK_ORDER: RiskLabel[] = [
  "read",
  "write",
  "destructive",
  "external_send",
  "code_execution",
  "file_mutation",
  "network_egress",
  "credential_access",
  "financial",
  "sensitive_data",
  "unknown",
];

const TERMS: Record<Exclude<RiskLabel, "unknown">, RegExp[]> = {
  read: [
    /\bread\b/,
    /\bget\b/,
    /\blist\b/,
    /\bsearch\b/,
    /\bfind\b/,
    /\bfetch\b/,
    /\bretrieve\b/,
    /\binspect\b/,
    /\bdescribe\b/,
  ],
  write: [
    /\bwrite\b/,
    /\bcreate\b/,
    /\bupdate\b/,
    /\bset\b/,
    /\bpatch\b/,
    /\bpost\b/,
    /\bput\b/,
    /\bsave\b/,
    /\bupload\b/,
    /\bmerge\b/,
    /\bcommit\b/,
    /\binsert\b/,
  ],
  destructive: [
    /\bdelete\b/,
    /\bremove\b/,
    /\bdrop\b/,
    /\bdestroy\b/,
    /\breset\b/,
    /\brevoke\b/,
    /\bdisable\b/,
    /\btruncate\b/,
    /\boverwrite\b/,
    /\bpurge\b/,
  ],
  external_send: [
    /\bsend\b/,
    /\bemail\b/,
    /\bmessage\b/,
    /\bslack\b/,
    /\bnotify\b/,
    /\bwebhook\b/,
    /\bpublish\b/,
    /\btweet\b/,
    /\bcomment\b/,
  ],
  code_execution: [
    /\bexec\b/,
    /\bexecute\b/,
    /\brun_command\b/,
    /\bshell\b/,
    /\bcommand\b/,
    /\bscript\b/,
    /\beval\b/,
    /\bpython\b/,
    /\bbash\b/,
    /\bnode\b/,
    /\bbrowser_automation\b/,
  ],
  file_mutation: [
    /\bwrite_file\b/,
    /\bdelete_file\b/,
    /\bmove_file\b/,
    /\brename_file\b/,
    /\bmkdir\b/,
    /\bchmod\b/,
    /\bchown\b/,
  ],
  network_egress: [
    /\bhttp\b/,
    /\burl\b/,
    /\bfetch_url\b/,
    /\brequest\b/,
    /\bapi_call\b/,
    /\bcurl\b/,
    /\bwebhook\b/,
  ],
  credential_access: [
    /\bsecret\b/,
    /\btoken\b/,
    /\bapi_key\b/,
    /\bapikey\b/,
    /\bpassword\b/,
    /\bcredential\b/,
    /\boauth\b/,
    /\bauth\b/,
    /\bprivate_key\b/,
  ],
  financial: [
    /\bcharge\b/,
    /\bpayment\b/,
    /\bpay\b/,
    /\bpurchase\b/,
    /\brefund\b/,
    /\binvoice\b/,
    /\bsubscription\b/,
    /\bpayout\b/,
    /\btransfer\b/,
    /\bcheckout\b/,
  ],
  sensitive_data: [
    /\bpii\b/,
    /\bpersonal\b/,
    /\bcustomer\b/,
    /\bhealth\b/,
    /\bmedical\b/,
    /\bpatient\b/,
    /\bcard\b/,
    /\bssn\b/,
    /\bconfidential\b/,
    /\bprivate\b/,
    /\bbulk_export\b/,
    /\bexport\b/,
  ],
};

export function classifyToolCall(
  metadata: ToolMetadata,
  args: JsonObject,
): Classification {
  const labels = new Set<RiskLabel>();
  const reasons: string[] = [];
  const haystack = buildHaystack(metadata, args);
  const stringSignals = collectStringSignals(args).join(" ").toLowerCase();

  if (metadata.annotations["readOnlyHint"] === true) {
    labels.add("read");
    reasons.push("MCP annotation readOnlyHint=true.");
  }

  if (hasSuspiciousMetadata(metadata)) {
    labels.add("unknown");
    reasons.push("Tool metadata contains suspicious instruction-like text.");
  }

  const sqlStatements = collectSqlStatements(args);
  if (sqlStatements.length > 0) {
    applySqlClassification(sqlStatements, labels, reasons);
  }

  applyStringValueClassification(stringSignals, labels, reasons);

  for (const label of RISK_ORDER) {
    if (label === "unknown") {
      continue;
    }

    if (label === "read" && hasAnyNonReadRisk(labels)) {
      continue;
    }

    const matched = TERMS[label].some((pattern) => pattern.test(haystack));
    if (matched) {
      labels.add(label);
      reasons.push(`Matched ${label} heuristic.`);
    }
  }

  if (labels.has("destructive")) {
    labels.add("write");
  }

  if (labels.has("file_mutation")) {
    labels.add("write");
  }

  if (labels.has("financial")) {
    labels.add("external_send");
  }

  if (labels.has("credential_access")) {
    labels.add("sensitive_data");
  }

  if (labels.size === 0) {
    labels.add("unknown");
    reasons.push("No deterministic risk heuristic matched.");
  }

  return {
    labels: sortLabels([...labels]),
    reasons,
  };
}

function buildHaystack(metadata: ToolMetadata, args: JsonObject): string {
  const parts = [
    metadata.ref.fullName,
    metadata.ref.name,
    metadata.description,
    JSON.stringify(metadata.inputSchema),
    JSON.stringify(collectKeys(args)),
  ];

  return parts
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[./:-]/g, "_")
    .toLowerCase();
}

function collectKeys(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectKeys(entry));
  }

  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => [
      key,
      ...collectKeys(nested),
    ]);
  }

  return [];
}

function collectStringSignals(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringSignals(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((nested) => collectStringSignals(nested));
  }

  if (typeof value === "string") {
    return [value.slice(0, 1000)];
  }

  return [];
}

const SQL_START_PATTERN =
  /^\s*(?:select|with|show|describe|desc|explain|values|insert|update|upsert|delete|drop|truncate|alter|create|replace|merge|grant|revoke|copy|load|call|do|vacuum|analyze|reindex|begin|commit|rollback)\b/i;

function collectSqlStatements(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectSqlStatements(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((nested) => collectSqlStatements(nested));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed || !SQL_START_PATTERN.test(trimmed)) {
    return [];
  }

  return [trimmed];
}

function applySqlClassification(
  sqlStatements: string[],
  labels: Set<RiskLabel>,
  reasons: string[],
): void {
  const normalizedStatements = sqlStatements
    .map((sql) => normalizeSqlForMatching(sql))
    .filter((sql) => sql.length > 0);

  if (normalizedStatements.length === 0) {
    return;
  }

  const combined = normalizedStatements.join("; ");
  const statementParts = combined
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  const hasDestructiveSql =
    /\b(drop|delete|truncate)\b/.test(combined) ||
    /\balter\s+(table|database|schema|view|materialized\s+view|index|sequence|type)\b/.test(
      combined,
    ) ||
    /\brevoke\b/.test(combined);

  const hasWriteSql =
    hasDestructiveSql ||
    /\b(insert|update|upsert|create|replace|merge|grant|vacuum|reindex)\b/.test(
      combined,
    ) ||
    /\bselect\b[\s\S]*\bfor\s+update\b/.test(combined) ||
    /\bcopy\b[\s\S]*\bfrom\b/.test(combined) ||
    /\bload\s+data\b/.test(combined);

  const hasPrivilegeSql =
    /\b(create|alter|drop)\s+(user|role|login)\b/.test(combined) ||
    /\b(grant|revoke)\b/.test(combined) ||
    /\b(pg_authid|mysql\.user|user_privileges|password|credential|api_?key|secret|private_?key)\b/.test(
      combined,
    );

  const hasSensitiveSql =
    hasPrivilegeSql ||
    /\b(users?|customers?|accounts?|patients?|employees?|payments?|invoices?|orders?|sessions?|tokens?|oauth|auth|ssn|social_security|email|phone|address|dob|birth|medical|health|card|credit_?card|billing|secrets?)\b/.test(
      combined,
    ) ||
    /\b(copy|unload)\b[\s\S]*\bto\b/.test(combined);

  const hasFileSql =
    /\b(pg_read_file|pg_ls_dir|lo_import|lo_export|load_file)\b/.test(
      combined,
    ) ||
    /\binto\s+(out|dump)?file\b/.test(combined) ||
    /\bcopy\b[\s\S]*\bto\b/.test(combined);

  const hasNetworkSql =
    /\b(dblink|postgres_fdw|mysql_fdw|http_get|http_post|http_request|net\.http|aws_s3|s3_export|gcs|azure)\b/.test(
      combined,
    ) || /\b(unload|copy)\b[\s\S]*\bto\b[\s\S]*\b(s3|gs|azure|http)\b/.test(combined);

  const hasExternalSendSql = /\b(copy|unload)\b[\s\S]*\bto\b/.test(combined);

  const hasCodeExecutionSql =
    /\bcopy\b[\s\S]*\bprogram\b/.test(combined) ||
    /\b(create\s+extension|load_extension|xp_cmdshell)\b/.test(combined) ||
    /\blanguage\s+(plpython|plperlu|c)\b/.test(combined) ||
    /^\s*do\b/.test(combined);

  const hasReadOnlySql =
    statementParts.length > 0 &&
    statementParts.every((statement) =>
      /^(select|show|describe|desc|explain|values|with)\b/.test(statement),
    );

  if (
    hasReadOnlySql &&
    !hasWriteSql &&
    !hasDestructiveSql &&
    !hasCodeExecutionSql &&
    !hasFileSql &&
    !hasNetworkSql
  ) {
    labels.add("read");
    reasons.push("SQL appears read-only.");
  }

  if (hasDestructiveSql) {
    labels.add("destructive");
    labels.add("write");
    reasons.push("SQL contains destructive mutation keyword.");
  }

  if (hasWriteSql && !hasDestructiveSql) {
    labels.add("write");
    reasons.push("SQL contains mutation keyword.");
  }

  if (hasSensitiveSql) {
    labels.add("sensitive_data");
    reasons.push("SQL references sensitive-looking data or exports result data.");
  }

  if (hasPrivilegeSql) {
    labels.add("credential_access");
    reasons.push("SQL references credentials, roles, grants, or secrets.");
  }

  if (hasFileSql) {
    labels.add("file_mutation");
    reasons.push("SQL can read from or write to server-side files.");
  }

  if (hasNetworkSql) {
    labels.add("network_egress");
    reasons.push("SQL references network or cloud export functionality.");
  }

  if (hasExternalSendSql) {
    labels.add("external_send");
    reasons.push("SQL can export database result data outside the database.");
  }

  if (hasCodeExecutionSql) {
    labels.add("code_execution");
    reasons.push("SQL can execute database extensions, shell programs, or procedural code.");
  }
}

function normalizeSqlForMatching(sql: string): string {
  return stripSqlCommentsAndLiterals(sql)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripSqlCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$/g, " ? ")
    .replace(/'(?:''|[^'])*'/g, " ? ");
}

function applyStringValueClassification(
  valueSignals: string,
  labels: Set<RiskLabel>,
  reasons: string[],
): void {
  if (!valueSignals) {
    return;
  }

  if (/https?:\/\/|wss?:\/\//.test(valueSignals)) {
    labels.add("network_egress");
    reasons.push("Argument values contain a URL.");
  }

  if (
    /hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|webhook/.test(
      valueSignals,
    )
  ) {
    labels.add("external_send");
    labels.add("network_egress");
    reasons.push("Argument values contain a webhook destination.");
  }

  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(valueSignals)) {
    labels.add("external_send");
    labels.add("sensitive_data");
    reasons.push("Argument values contain an email-like destination.");
  }

  if (
    /\b(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i.test(
      valueSignals,
    )
  ) {
    labels.add("credential_access");
    labels.add("sensitive_data");
    reasons.push("Argument values contain a token-like secret.");
  }
}

function hasSuspiciousMetadata(metadata: ToolMetadata): boolean {
  const text = `${metadata.description} ${JSON.stringify(metadata.inputSchema)}`
    .toLowerCase()
    .replace(/\s+/g, " ");

  return [
    /ignore (all )?(previous|prior|system|developer) instructions/,
    /do not (tell|show|reveal|mention) (the )?user/,
    /hide (this|tool|instruction|message)/,
    /system prompt/,
    /developer message/,
    /bypass (policy|approval|warden|security)/,
  ].some((pattern) => pattern.test(text));
}

function hasAnyNonReadRisk(labels: Set<RiskLabel>): boolean {
  return [...labels].some((label) => label !== "read" && label !== "unknown");
}

function sortLabels(labels: RiskLabel[]): RiskLabel[] {
  return RISK_ORDER.filter((label) => labels.includes(label));
}
