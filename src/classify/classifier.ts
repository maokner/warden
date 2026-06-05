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

  const sql = findSql(args);
  if (sql) {
    applySqlClassification(sql, labels, reasons);
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

function findSql(args: JsonObject): string | undefined {
  for (const key of ["sql", "query", "statement"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().toLowerCase();
    }
  }

  return undefined;
}

function applySqlClassification(
  sql: string,
  labels: Set<RiskLabel>,
  reasons: string[],
): void {
  const normalized = sql.replace(/\s+/g, " ");

  if (/^(select|show|describe|explain|with)\b/.test(normalized)) {
    labels.add("read");
    reasons.push("SQL appears read-only.");
  }

  if (/\b(drop|delete|truncate|alter)\b/.test(normalized)) {
    labels.add("destructive");
    labels.add("write");
    reasons.push("SQL contains destructive mutation keyword.");
  }

  if (/\b(insert|update|create|replace|merge)\b/.test(normalized)) {
    labels.add("write");
    reasons.push("SQL contains mutation keyword.");
  }
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
