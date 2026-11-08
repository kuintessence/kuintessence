import { writeFile } from "node:fs/promises";
import {
  FederationCurrentCapabilitiesSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  ClosingPolicyInputSchema,
  ClosingPolicySchema,
  ClosingTasksViewSchema,
  type CommercialAgreementApproval,
  CommercialAgreementApprovalSchema,
  CommercialAgreementSummarySchema,
  CommercialBillApprovalSchema,
  CommercialBillListSchema,
  CommercialBillSchema,
  CommercialSettlementApprovalSchema,
  CommercialSettlementListSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import type { Command } from "commander";
import { z } from "zod";
import { ApiClient, ApiError } from "../lib/api-client";
import { type CliConfig, loadCliConfig } from "../lib/config";

type Kind = "bill" | "settlement";
const labels = {
  zh: {
    login: "请先运行 kq login",
    org: "请使用 --org 指定当前会话机构；用 federation organizations 查看，用 federation use 显式切换",
    invalid: "参数、文件或响应不符合联邦协议",
    scope: "响应与指定机构或合同不符",
    unknown: "写入结果未确认。请先查询原记录，不要重新生成或重复提交授权",
    failed: "请求失败",
    saved: "已保存",
    granted: "已授予机构授权",
    revoked: "已撤销机构授权",
    retry: "已请求处理原记录",
    attached: "已导入对方原签名",
    approved: "已批准原文；不代表付款或链上确认",
    selected: "当前会话机构已切换",
    signatures: "签署",
    both: "双方已签署",
    local: "仅本站批准",
    accounting: "本站记账",
    applied: "已处理",
    unapplied: "未处理",
    ledger: "本站存证",
    notRequired: "不要求",
    unknownLedger: "未同步",
    noRecord: "暂无本站记录",
    pending: "待处理",
    committed: "已确认",
    needs_review: "需人工处理",
    complete: "双方已签署",
    enabled: "发送通道已配置",
    disabled: "发送通道未配置",
    active: "有效",
    expired: "已到期",
    exhausted: "次数已用完",
    notStarted: "尚未生效",
    revokedState: "已撤销",
    amount: "累计批准额/上限",
    perRecord: "单笔上限",
    outcomes: "允许结果",
    reserved: "预留",
    charged: "扣用",
    released: "归还",
    count: "批准次数/上限",
    expires: "到期",
    kind: "类型",
    bill: "账单",
    settlement: "结算",
    empty: "无记录",
  },
  en: {
    login: "Run kq login first",
    org: "Use --org to pin the active session organization; inspect federation organizations and explicitly select with federation use",
    invalid: "Invalid federation arguments, file or response",
    scope: "Response does not match the requested organization or contract",
    unknown:
      "Write outcome unconfirmed. Query the original record before regenerating or submitting authority again",
    failed: "Request failed",
    saved: "Saved",
    granted: "Institution authority granted",
    revoked: "Institution authority revoked",
    retry: "Original processing requested",
    attached: "Original counterparty signature imported",
    approved: "Original approved; this is not payment or ledger confirmation",
    selected: "Active session organization changed",
    signatures: "Signatures",
    both: "Both signed",
    local: "Locally approved",
    accounting: "Local accounting",
    applied: "Applied",
    unapplied: "Not applied",
    ledger: "Local evidence",
    notRequired: "Not required",
    unknownLedger: "Not synchronized",
    noRecord: "No local record",
    pending: "Pending",
    committed: "Committed",
    needs_review: "Needs review",
    complete: "Both signed",
    enabled: "Sending transport configured",
    disabled: "Sending transport not configured",
    active: "Active",
    expired: "Expired",
    exhausted: "Approval count exhausted",
    notStarted: "Not effective yet",
    revokedState: "Revoked",
    amount: "Approved amount/limit",
    perRecord: "Per-record limit",
    outcomes: "Allowed outcomes",
    reserved: "Reserved",
    charged: "Charged",
    released: "Returned",
    count: "Approvals/limit",
    expires: "Expires",
    kind: "Kind",
    bill: "Bill",
    settlement: "Settlement",
    empty: "No records",
  },
};
type Label = keyof typeof labels.en;
const pageOptions = z.object({
  limit: z.coerce.number().int().min(1).max(100),
  offset: z.coerce.number().int().nonnegative(),
});

async function readInput(file: string) {
  const value = await Bun.file(file).slice(0, 600001).text();
  if (Buffer.byteLength(value) > 600000) throw new Error("Federation input exceeds 600000 bytes");
  return value;
}
async function save(file: string, data: unknown) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function checkScope(
  row: { localOrgId: string; localSiteId: string; agreementRevisionId: string },
  contract: CommercialAgreementApproval,
) {
  if (
    row.localOrgId !== contract.localOrgId ||
    row.localSiteId !== contract.localSiteId ||
    row.agreementRevisionId !== contract.revisionId
  )
    throw new Error("Federation response scope mismatch");
}
function checkBusiness(kind: Kind, raw: unknown, contract: CommercialAgreementApproval) {
  const value =
    kind === "bill" ? CommercialBillSchema.parse(raw) : CommercialSettlementSchema.parse(raw);
  const parties =
    value.kind === "commercial-bill"
      ? {
          source: value.request.senderSiteId,
          target: value.request.recipientSiteId,
          revision: value.request.agreementRevisionId,
          unit: value.request.unit,
        }
      : {
          source: value.sourceSiteId,
          target: value.targetSiteId,
          revision: value.agreementRevisionId,
          unit: value.unit,
        };
  if (
    value.domainId !== contract.terms.domainId ||
    parties.source !== contract.terms.agreement.sourceSiteId ||
    parties.target !== contract.terms.agreement.targetSiteId ||
    parties.revision !== contract.revisionId ||
    parties.unit !== contract.terms.agreement.unit ||
    (value.kind === "commercial-bill" && value.agreementDigest !== contract.digest)
  )
    throw new Error("Federation original does not match contract");
  return value;
}

function checkRecordIdentity(
  row:
    | z.infer<typeof CommercialBillApprovalSchema>
    | z.infer<typeof CommercialSettlementApprovalSchema>,
) {
  if (
    row.billId !== row.payload.billId ||
    (row.payload.kind === "commercial-settlement" &&
      (!("settlementId" in row) || row.settlementId !== row.payload.settlementId))
  )
    throw new Error("Federation response record identity mismatch");
}

export function registerFederationCommand(
  program: Command,
  readConfig: () => CliConfig = loadCliConfig,
) {
  const root = program
    .command("federation")
    .description("Federation cooperation and commercial approvals")
    .option("--org <uuid>", "Expected active organization (does not switch the session)")
    .option("--lang <language>", "zh or en", "zh")
    .option("--json", "Print validated private records as JSON");
  const settings = () => {
    const options = z
      .object({
        org: z.uuid().optional(),
        lang: z.enum(["zh", "en"]),
        json: z.boolean().optional(),
      })
      .parse(root.opts());
    const t = (key: Label) => labels[options.lang][key];
    const config = readConfig();
    if (!config.token) throw new Error(t("login"));
    const client = new ApiClient(config.serverUrl.replace(/\/+$/, ""), config.token, {
      organizationId: options.org,
    });
    return { ...options, client, t };
  };
  const scoped = () => {
    const s = settings();
    if (!s.org) throw new Error(s.t("org"));
    return { ...s, org: s.org };
  };
  type Session = ReturnType<typeof scoped>;
  const output = (s: ReturnType<typeof settings>, value: unknown, lines: string[]) =>
    console.log(s.json ? JSON.stringify(value, null, 2) : lines.join("\n"));
  const get = async <S extends z.ZodType>(
    s: Session,
    path: string,
    schema: S,
  ): Promise<z.output<S>> =>
    schema.parse(z.object({ data: z.unknown() }).parse(await s.client.get(path)).data);
  const post = async <S extends z.ZodType>(
    s: Session,
    path: string,
    input: unknown,
    schema: S,
  ): Promise<z.output<S>> => {
    try {
      return schema.parse(
        z.object({ data: z.unknown() }).parse(await s.client.post(path, input)).data,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  };
  const contract = async (s: Session, revision: string) => {
    const value = await get(
      s,
      `/federation/commercial-agreements/${z.uuid().parse(revision)}`,
      CommercialAgreementApprovalSchema,
    );
    if (
      value.localOrgId !== s.org ||
      value.revisionId !== revision ||
      ![value.terms.agreement.sourceSiteId, value.terms.agreement.targetSiteId].includes(
        value.localSiteId,
      )
    )
      throw new Error(s.t("scope"));
    return value;
  };
  const base = (value: CommercialAgreementApproval) =>
    `/federation/commercial-agreements/${value.revisionId}`;
  const page = (command: Command) =>
    command
      .option("--limit <count>", "Page size, 1–100", "20")
      .option("--offset <count>", "Page offset", "0");
  const query = (raw: unknown) => {
    const p = pageOptions.parse(raw);
    return `limit=${p.limit}&offset=${p.offset}`;
  };
  const action = (command: Command, fn: (...args: string[]) => Promise<void>) =>
    command.action(async (...args: string[]) => {
      try {
        await fn(...args);
      } catch (error) {
        const lang = root.opts().lang === "en" ? "en" : "zh";
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          throw new Error(labels[lang].invalid);
        if (error instanceof ApiError)
          throw new Error(`${labels[lang].failed}: HTTP ${error.status} ${error.code}`);
        throw error;
      }
    });
  const organizations = z.object({
    activeOrganizationId: z.uuid().nullable(),
    organizations: z.array(z.object({ orgId: z.uuid(), name: z.string(), role: z.string() })),
  });
  action(
    root
      .command("organizations")
      .description("Inspect session organization and available organizations"),
    async () => {
      const s = settings(),
        value = organizations.parse(await s.client.get("/me/active-organization"));
      output(
        s,
        value,
        value.organizations.map(
          (row) =>
            `${row.orgId === value.activeOrganizationId ? "* " : "  "}${row.orgId}\t${row.name}\t${row.role}`,
        ),
      );
    },
  );
  action(
    root
      .command("use <organization>")
      .description("Explicitly change this human session's active organization"),
    async (organization) => {
      const s = settings(),
        organizationId = z.uuid().parse(organization);
      const value = z
        .object({ activeOrganizationId: z.uuid() })
        .parse(await s.client.put("/me/active-organization", { organizationId }));
      if (value.activeOrganizationId !== organizationId) throw new Error(s.t("scope"));
      output(s, value, [`${s.t("selected")}: ${organizationId}`]);
    },
  );
  action(
    root.command("capabilities").description("Inspect current institution permissions"),
    async () => {
      const s = scoped(),
        value = await get(s, "/federation/capabilities", FederationCurrentCapabilitiesSchema);
      if (value.orgId !== s.org) throw new Error(s.t("scope"));
      output(s, value, [value.orgId, ...value.effectiveCapabilities]);
    },
  );
  const contracts = root.command("contracts").description("Inspect signed commercial contracts");
  const listContracts = page(contracts.command("list"));
  action(listContracts, async () => {
    const s = scoped(),
      rows = await get(
        s,
        `/federation/commercial-agreements?${query(listContracts.opts())}`,
        z.array(CommercialAgreementSummarySchema),
      );
    output(
      s,
      rows,
      rows.length
        ? rows.map(
            (row) =>
              `${row.revisionId}\t${row.sourceName ?? row.sourceSiteId} → ${row.targetName ?? row.targetSiteId}\t${row.mode}\t${row.hasCounterpartyApproval ? s.t("both") : s.t("local")}`,
          )
        : [s.t("empty")],
    );
  });
  action(contracts.command("show <revision>"), async (revision) => {
    const s = scoped(),
      row = await contract(s, revision);
    output(s, row, [
      row.revisionId,
      `${row.terms.agreement.sourceSiteId} → ${row.terms.agreement.targetSiteId}`,
      row.terms.agreement.mode,
      `${s.t("signatures")}: ${row.counterpartyJws ? s.t("both") : s.t("local")}`,
      `${row.terms.agreement.budgetLimit} ${row.terms.agreement.unit}`,
    ]);
  });
  action(
    contracts
      .command("export <revision> <file>")
      .description("Export the original contract into a new owner-only file"),
    async (revision, file) => {
      const s = scoped();
      await save(file, (await contract(s, revision)).terms);
      console.log(s.t("saved"));
    },
  );
  const closing = root
    .command("closing")
    .description("Institution authority and automatic processing");
  const policies = closing.command("policies");
  const listPolicies = page(policies.command("list <revision>"));
  action(listPolicies, async (revision) => {
    const s = scoped(),
      c = await contract(s, revision),
      rows = await get(
        s,
        `${base(c)}/closing-policies?${query(listPolicies.opts())}`,
        z.array(ClosingPolicySchema),
      );
    for (const row of rows) {
      checkScope(row, c);
      if (row.agreementDigest !== c.digest) throw new Error(s.t("scope"));
    }
    output(
      s,
      rows,
      rows.length
        ? rows.map((row) => {
            const state = row.revokedAt
              ? "revokedState"
              : Date.parse(row.validUntil) <= Date.now()
                ? "expired"
                : Date.parse(row.validFrom) > Date.now()
                  ? "notStarted"
                  : row.approvedRecords >= row.maxRecords
                    ? "exhausted"
                    : "active";
            return `${row.id}\t${s.t(row.kind)}\t${s.t(state)}\n  ${s.t("perRecord")}: ${row.maxAmount} ${c.terms.agreement.unit}\t${s.t("outcomes")}: ${row.outcomes.join(", ")}\n  ${s.t("amount")}: ${row.approvedAmount}/${row.maxTotalAmount} ${c.terms.agreement.unit}\t${s.t("count")}: ${row.approvedRecords}/${row.maxRecords}\t${s.t("expires")}: ${row.validUntil}`;
          })
        : [s.t("empty")],
    );
  });
  action(
    policies
      .command("grant <revision> <file>")
      .description("Grant finite institution authority from reviewed JSON"),
    async (revision, file) => {
      const s = scoped(),
        input = ClosingPolicyInputSchema.parse(JSON.parse(await readInput(file))),
        c = await contract(s, revision);
      if (
        Date.parse(input.validUntil) <= Date.now() ||
        BigInt(input.maxAmount) > BigInt(c.terms.agreement.maxTaskAmount) ||
        BigInt(input.maxTotalAmount) > BigInt(c.terms.agreement.budgetLimit)
      )
        throw new Error(s.t("invalid"));
      const row = await post(s, `${base(c)}/closing-policies`, input, ClosingPolicySchema);
      checkScope(row, c);
      if (
        row.agreementDigest !== c.digest ||
        row.kind !== input.kind ||
        row.maxAmount !== input.maxAmount ||
        row.maxTotalAmount !== input.maxTotalAmount ||
        row.maxRecords !== input.maxRecords ||
        Date.parse(row.validUntil) !== Date.parse(input.validUntil) ||
        federationCanonicalJson(row.outcomes) !== federationCanonicalJson(input.outcomes) ||
        row.revokedAt !== null
      )
        throw new Error(s.t("unknown"));
      output(s, row, [`${s.t("granted")}: ${row.id}`]);
    },
  );
  action(policies.command("revoke <revision> <policy>"), async (revision, policy) => {
    const s = scoped(),
      id = z.uuid().parse(policy),
      c = await contract(s, revision),
      row = await post(s, `${base(c)}/closing-policies/${id}/revoke`, {}, ClosingPolicySchema);
    checkScope(row, c);
    if (row.id !== id || row.revokedAt === null) throw new Error(s.t("unknown"));
    output(s, row, [`${s.t("revoked")}: ${row.id}`]);
  });
  const tasks = closing.command("tasks"),
    listTasks = page(tasks.command("list <revision>"));
  action(listTasks, async (revision) => {
    const s = scoped(),
      c = await contract(s, revision),
      view = await get(
        s,
        `${base(c)}/closing-tasks?${query(listTasks.opts())}`,
        ClosingTasksViewSchema,
      );
    for (const row of view.records) checkScope(row, c);
    output(s, view, [
      s.t(view.enabled ? "enabled" : "disabled"),
      ...view.records.map(
        (row) =>
          `${s.t(row.kind)}\t${row.referenceId}\t${s.t(row.state)}\t${row.recordId ?? "-"}\t${row.lastError ?? "-"}`,
      ),
    ]);
  });
  action(
    tasks.command("retry <revision> <kind> <reference>"),
    async (revision, rawKind, reference) => {
      const s = scoped(),
        kind = z.enum(["bill", "settlement"]).parse(rawKind),
        id = z.uuid().parse(reference),
        c = await contract(s, revision);
      try {
        z.object({ success: z.literal(true) }).parse(
          await s.client.post(`${base(c)}/closing-tasks/${kind}/${id}/retry`, {}),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new Error(s.t("unknown"));
      }
      output(s, { kind, referenceId: id }, [s.t("retry")]);
    },
  );
  for (const kind of ["bill", "settlement"] as const) {
    const group = root.command(`${kind}s`);
    const list = page(
      group.command("list <revision>").option("--record <uuid>", "Filter the original record"),
    );
    action(list, async (revision) => {
      const s = scoped(),
        c = await contract(s, revision),
        record = z.uuid().optional().parse(list.opts().record);
      const path = `${base(c)}/${kind}s?${query(list.opts())}${record ? `&recordId=${record}` : ""}`;
      if (kind === "bill") {
        const view = await get(s, path, CommercialBillListSchema);
        for (const { bill } of view.data) {
          checkScope(bill, c);
          checkRecordIdentity(bill);
          checkBusiness(kind, bill.payload, c);
          if (record && record !== bill.billId) throw new Error(s.t("scope"));
        }
        output(
          s,
          view,
          view.data.length
            ? view.data.map(
                ({ bill, ledger }) =>
                  `${bill.billId}\t${bill.payload.calculation.dueAmount} ${c.terms.agreement.unit}\n  ${s.t("signatures")}: ${bill.counterpartyJws ? s.t("both") : s.t("local")}\t${s.t("ledger")}: ${c.terms.agreement.mode === "bilateral_direct" ? s.t("notRequired") : ledger ? s.t(ledger.state) : s.t(c.localSiteId === c.terms.agreement.targetSiteId ? "noRecord" : "unknownLedger")}`,
              )
            : [s.t("empty")],
        );
      } else {
        const view = await get(s, path, CommercialSettlementListSchema);
        for (const { settlement } of view.data) {
          checkScope(settlement, c);
          checkRecordIdentity(settlement);
          checkBusiness(kind, settlement.payload, c);
          if (record && record !== settlement.settlementId) throw new Error(s.t("scope"));
        }
        output(
          s,
          view,
          view.data.length
            ? view.data.map(
                ({ settlement, ledger }) =>
                  `${settlement.settlementId}\t${s.t("reserved")}: ${settlement.payload.reservedAmount}\t${s.t("charged")}: ${settlement.payload.chargedAmount}\t${s.t("released")}: ${settlement.payload.releasedAmount} ${c.terms.agreement.unit}\n  ${s.t("signatures")}: ${settlement.counterpartyJws ? s.t("both") : s.t("local")}\t${s.t("accounting")}: ${settlement.appliedAt ? s.t("applied") : s.t("unapplied")}\t${s.t("ledger")}: ${c.terms.agreement.mode === "bilateral_direct" ? s.t("notRequired") : ledger ? s.t(ledger.state) : s.t("noRecord")}`,
              )
            : [s.t("empty")],
        );
      }
    });
    const draft = group
      .command("draft <revision> <reference> <file>")
      .description(
        `Generate a ${kind} draft from ${kind === "bill" ? "report ID" : "bill ID"}; never approves`,
      )
      .option("--id <uuid>", "Original draft ID");
    action(draft, async (revision, reference, file) => {
      const s = scoped(),
        ref = z.uuid().parse(reference),
        id = z.uuid().parse(draft.opts().id ?? crypto.randomUUID()),
        c = await contract(s, revision);
      const input =
        kind === "bill" ? { reportId: ref, billId: id } : { billId: ref, settlementId: id };
      const value = checkBusiness(
        kind,
        await post(
          s,
          `${base(c)}/${kind}s/draft`,
          input,
          kind === "bill" ? CommercialBillSchema : CommercialSettlementSchema,
        ),
        c,
      );
      if (
        value.kind === "commercial-bill"
          ? value.billId !== id || value.reportId !== ref
          : value.settlementId !== id || value.billId !== ref
      )
        throw new Error(s.t("scope"));
      await save(file, value);
      console.log(s.t("saved"));
    });
    action(
      group
        .command("approve <revision> <file>")
        .description("Approve the reviewed original, without regenerating it"),
      async (revision, file) => {
        const s = scoped(),
          c = await contract(s, revision),
          input = checkBusiness(kind, JSON.parse(await readInput(file)), c);
        const row = await post(
          s,
          `${base(c)}/${kind}s/approve`,
          input,
          kind === "bill" ? CommercialBillApprovalSchema : CommercialSettlementApprovalSchema,
        );
        checkScope(row, c);
        checkRecordIdentity(row);
        if (federationCanonicalJson(row.payload) !== federationCanonicalJson(input))
          throw new Error(s.t("unknown"));
        output(s, row, [
          s.t("approved"),
          row.payload.kind === "commercial-bill" ? row.payload.billId : row.payload.settlementId,
        ]);
      },
    );
    action(
      group
        .command("attach <revision> <record> <file>")
        .description("Import the counterpart's original JWS from a file"),
      async (revision, record, file) => {
        const s = scoped(),
          id = z.uuid().parse(record),
          approvalJws = z
            .string()
            .min(1)
            .max(524288)
            .parse((await readInput(file)).trim()),
          c = await contract(s, revision);
        const row = await post(
          s,
          `${base(c)}/${kind}s/${id}/counterparty`,
          { approvalJws },
          kind === "bill" ? CommercialBillApprovalSchema : CommercialSettlementApprovalSchema,
        );
        checkScope(row, c);
        checkRecordIdentity(row);
        checkBusiness(kind, row.payload, c);
        if (
          (row.payload.kind === "commercial-bill"
            ? row.payload.billId
            : row.payload.settlementId) !== id ||
          row.counterpartyJws !== approvalJws
        )
          throw new Error(s.t("unknown"));
        output(s, row, [s.t("attached")]);
      },
    );
  }
}
