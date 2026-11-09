import { writeFile } from "node:fs/promises";
import {
  FederationAnyMediaExportApprovalSchema,
  FederationCurrentCapabilitiesSchema,
  FederationMediaImportApprovalSchema,
  FederationMediaRegistrationSchema,
  FederationMediaRevocationSchema,
  federationCanonicalJson,
  MediaDeviceListSchema,
  MediaDeviceRegistrationSchema,
  MediaDeviceSchema,
  MediaDeviceUpdateSchema,
  MediaExportDetailSchema,
  MediaExportOperationSchema,
  MediaExportSummarySchema,
  MediaHandoffRecordSchema,
  MediaHandoffSchema,
  MediaImportAuthorizationSchema,
  MediaImportOperationSchema,
  MediaImportReceiptViewSchema,
  MediaLogisticsContextSchema,
  MediaPackageDetailSchema,
  MediaPackageSummarySchema,
  MediaRecordedReceiptSchema,
  MediaShipmentDetailSchema,
  MediaShipmentListSchema,
  MediaShipmentRegistrationSchema,
  MediaShipmentSchema,
  MediaTransportPackagesSchema,
} from "@kuintessence/shared/federation";
import {
  ClosingPolicyInputSchema,
  ClosingPolicySchema,
  ClosingTasksViewSchema,
  CommercialAdjustmentApprovalSchema,
  CommercialAdjustmentDraftInputSchema,
  CommercialAdjustmentListSchema,
  CommercialAdjustmentSchema,
  type CommercialAgreementApproval,
  CommercialAgreementApprovalSchema,
  CommercialAgreementSummarySchema,
  CommercialBillApprovalSchema,
  CommercialBillListSchema,
  CommercialBillSchema,
  CommercialPaymentApprovalSchema,
  CommercialPaymentDraftInputSchema,
  CommercialPaymentListSchema,
  CommercialPaymentSchema,
  CommercialRefundApprovalSchema,
  CommercialRefundDraftInputSchema,
  CommercialRefundListSchema,
  CommercialRefundSchema,
  CommercialSettlementApprovalSchema,
  CommercialSettlementListSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import type { Command } from "commander";
import { z } from "zod";
import { ApiClient, ApiError } from "../lib/api-client";
import { type CliConfig, loadCliConfig } from "../lib/config";

const businessSchemas = {
  bill: CommercialBillSchema,
  settlement: CommercialSettlementSchema,
  adjustment: CommercialAdjustmentSchema,
  refund: CommercialRefundSchema,
  payment: CommercialPaymentSchema,
};
const approvalSchemas = {
  bill: CommercialBillApprovalSchema,
  settlement: CommercialSettlementApprovalSchema,
  adjustment: CommercialAdjustmentApprovalSchema,
  refund: CommercialRefundApprovalSchema,
  payment: CommercialPaymentApprovalSchema,
};
type Kind = keyof typeof businessSchemas;
function recordId(value: z.infer<(typeof businessSchemas)[Kind]>) {
  return value.kind === "commercial-bill"
    ? value.billId
    : value.kind === "commercial-settlement"
      ? value.settlementId
      : value.kind === "commercial-refund"
        ? value.refundId
        : value.kind === "commercial-payment"
          ? value.receiptId
          : value.adjustmentId;
}
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
    statement: "付款声明",
    current: "当前确认",
    superseded: "历史更正前值",
    unconfirmed: "待双方确认",
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
    previousCharge: "调整前净额",
    newCharge: "调整后净额",
    held: "批准时占额",
    released: "归还",
    count: "批准次数/上限",
    expires: "到期",
    kind: "类型",
    bill: "账单",
    settlement: "结算",
    refund: "退款",
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
    statement: "Payment statement",
    current: "Current confirmation",
    superseded: "Superseded",
    unconfirmed: "Awaiting both parties",
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
    previousCharge: "Previous net charge",
    newCharge: "New net charge",
    held: "Hold at approval",
    released: "Returned",
    count: "Approvals/limit",
    expires: "Expires",
    kind: "Kind",
    bill: "Bill",
    settlement: "Settlement",
    refund: "Refund",
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
  const value = businessSchemas[kind].parse(raw);
  const parties =
    value.kind === "commercial-bill" || value.kind === "commercial-refund"
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
    (["commercial-bill", "commercial-refund", "commercial-payment"].includes(value.kind) &&
      "agreementDigest" in value &&
      value.agreementDigest !== contract.digest) ||
    (value.kind === "commercial-payment" && contract.terms.consideration !== "paid") ||
    (value.kind === "commercial-refund" &&
      (value.request.mode !== contract.terms.agreement.mode ||
        value.request.budgetDomainId !== contract.terms.agreement.budgetDomainId ||
        value.request.epoch !== contract.terms.agreement.epoch))
  )
    throw new Error("Federation original does not match contract");
  return value;
}

function checkRecordIdentity(
  row:
    | z.infer<typeof CommercialBillApprovalSchema>
    | z.infer<typeof CommercialSettlementApprovalSchema>
    | z.infer<typeof CommercialAdjustmentApprovalSchema>
    | z.infer<typeof CommercialRefundApprovalSchema>
    | z.infer<typeof CommercialPaymentApprovalSchema>,
) {
  if (
    ("billId" in row && row.billId !== row.payload.billId) ||
    (row.payload.kind === "commercial-adjustment" &&
      (!("adjustmentId" in row) ||
        row.adjustmentId !== row.payload.adjustmentId ||
        row.settlementId !== row.payload.settlementId)) ||
    (row.payload.kind === "commercial-refund" &&
      (!("refundId" in row) ||
        row.refundId !== row.payload.refundId ||
        row.operationId !== row.payload.request.operationId)) ||
    (row.payload.kind === "commercial-payment" &&
      (!("receiptId" in row) ||
        row.receiptId !== row.payload.receiptId ||
        row.paymentId !== row.payload.paymentId)) ||
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
  const media = root
    .command("media")
    .description("Encrypted delivery, import authorization and physical media custody");
  const mediaBase = "/federation/media";
  const mediaContext = async (s: Session) => {
    const context = await get(s, `${mediaBase}/logistics-context`, MediaLogisticsContextSchema);
    if (context.localOrgId !== s.org) throw new Error(s.t("scope"));
    return context;
  };
  const mediaScope = <T extends { localOrgId: string; localSiteId: string }>(
    row: T,
    context: z.infer<typeof MediaLogisticsContextSchema>,
  ) => {
    if (row.localOrgId !== context.localOrgId || row.localSiteId !== context.localSiteId)
      throw new Error("Media response scope mismatch");
    return row;
  };
  const devices = media.command("devices").description("Device inventory");
  const deviceList = page(devices.command("list"));
  action(deviceList, async () => {
    const s = scoped(),
      pagination = query(deviceList.opts()),
      context = await mediaContext(s);
    const value = MediaDeviceListSchema.parse(
      await s.client.get(`${mediaBase}/devices?${pagination}`),
    );
    for (const row of value.data) mediaScope(row.device, context);
    output(s, value, [
      ...value.data.map(
        ({ device, activeShipmentId }) =>
          `${device.deviceId}\t${device.name}\t${device.assetTag}\t${device.state}\t${device.capacityBytes} B${activeShipmentId ? `\t${activeShipmentId}` : ""}`,
      ),
      ...(value.hasMore
        ? [s.lang === "zh" ? "还有下一页；使用 --offset" : "More records; use --offset"]
        : []),
    ]);
  });
  action(devices.command("register <file>"), async (file) => {
    const s = scoped(),
      input = MediaDeviceRegistrationSchema.parse(JSON.parse(await readInput(file))),
      context = await mediaContext(s);
    try {
      const row = mediaScope(
        await post(s, `${mediaBase}/devices`, input, MediaDeviceSchema),
        context,
      );
      if (
        row.deviceId !== input.deviceId ||
        row.name !== input.name ||
        row.assetTag !== input.assetTag ||
        row.capacityBytes !== input.capacityBytes
      )
        throw new Error("Device mismatch");
      output(s, row, [`${s.t("saved")}: ${row.deviceId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  action(devices.command("update <deviceId> <file>"), async (deviceId, file) => {
    z.uuid().parse(deviceId);
    const s = scoped(),
      input = MediaDeviceUpdateSchema.parse(JSON.parse(await readInput(file))),
      context = await mediaContext(s);
    try {
      const row = mediaScope(
        MediaDeviceSchema.parse(
          z
            .object({ data: z.unknown() })
            .parse(await s.client.patch(`${mediaBase}/devices/${deviceId}`, input)).data,
        ),
        context,
      );
      if (
        row.deviceId !== deviceId ||
        row.version !== input.expectedVersion + 1 ||
        row.name !== input.name ||
        row.state !== input.state
      )
        throw new Error("Device update mismatch");
      output(s, row, [`${s.t("saved")}: ${row.deviceId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  const packages = page(media.command("packages").description("List transport package summaries"));
  action(packages, async () => {
    const s = scoped(),
      pagination = query(packages.opts()),
      context = await mediaContext(s);
    const value = mediaScope(
      MediaTransportPackagesSchema.parse(
        await s.client.get(`${mediaBase}/transport-packages?${pagination}`),
      ),
      context,
    );
    output(s, value, [
      ...value.data.map(
        (row) =>
          `${row.packageId}\t${row.senderName ?? row.senderSiteId} → ${row.recipientName ?? row.recipientSiteId}\t${row.subjectKind}\t${row.manifestDigest}${row.revokedAt ? `\t${s.t("revokedState")}` : ""}`,
      ),
      ...(value.hasMore
        ? [s.lang === "zh" ? "还有下一页；使用 --offset" : "More records; use --offset"]
        : []),
    ]);
  });
  const shipments = media
    .command("shipments")
    .description("Shipment registration and custody history");
  const shipmentList = page(shipments.command("list"));
  action(shipmentList, async () => {
    const s = scoped(),
      pagination = query(shipmentList.opts()),
      context = await mediaContext(s);
    const value = MediaShipmentListSchema.parse(
      await s.client.get(`${mediaBase}/shipments?${pagination}`),
    );
    for (const row of value.data) mediaScope(row, context);
    output(s, value, [
      ...value.data.map(
        (row) =>
          `${row.shipmentId}\t${row.name}\t${row.state}\t${row.senderName ?? row.senderSiteId} → ${row.recipientName ?? row.recipientSiteId}`,
      ),
      ...(value.hasMore
        ? [s.lang === "zh" ? "还有下一页；使用 --offset" : "More records; use --offset"]
        : []),
    ]);
  });
  const shipmentShow = page(shipments.command("show <shipmentId>"));
  action(shipmentShow, async (shipmentId) => {
    z.uuid().parse(shipmentId);
    const s = scoped(),
      pagination = query(shipmentShow.opts()),
      context = await mediaContext(s);
    const value = await get(
      s,
      `${mediaBase}/shipments/${shipmentId}?${pagination}`,
      MediaShipmentDetailSchema,
    );
    mediaScope(value.shipment, context);
    if (value.shipment.shipmentId !== shipmentId) throw new Error(s.t("scope"));
    output(s, value, [
      `${value.shipment.name}\t${value.shipment.state}\tv${value.shipment.version}`,
      ...value.devices.map(({ device }) => `${device.deviceId}\t${device.assetTag}`),
      ...value.shipment.packages.map((row) => `${row.packageId}\t${row.manifestDigest}`),
      ...value.events.map(
        (row) =>
          `${row.eventId}\t${row.payload.state}\t${row.payload.occurredAt}\t${row.payload.note}`,
      ),
      ...(value.hasMore
        ? [s.lang === "zh" ? "还有下一页；使用 --offset" : "More records; use --offset"]
        : []),
    ]);
  });
  action(shipments.command("register <file>"), async (file) => {
    const s = scoped(),
      input = MediaShipmentRegistrationSchema.parse(JSON.parse(await readInput(file))),
      context = await mediaContext(s);
    try {
      const row = mediaScope(
        await post(s, `${mediaBase}/shipments`, input, MediaShipmentSchema),
        context,
      );
      if (
        row.shipmentId !== input.shipmentId ||
        row.name !== input.name ||
        federationCanonicalJson(row.packages.map((item) => item.packageId).sort()) !==
          federationCanonicalJson([...input.packageIds].sort())
      )
        throw new Error("Shipment mismatch");
      output(s, row, [`${s.t("saved")}: ${row.shipmentId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  action(shipments.command("handoff <shipmentId> <file>"), async (shipmentId, file) => {
    z.uuid().parse(shipmentId);
    const s = scoped(),
      input = MediaHandoffSchema.parse(JSON.parse(await readInput(file))),
      context = await mediaContext(s);
    try {
      const row = await post(
        s,
        `${mediaBase}/shipments/${shipmentId}/handoffs`,
        input,
        MediaHandoffRecordSchema,
      );
      if (
        row.localSiteId !== context.localSiteId ||
        row.shipmentId !== shipmentId ||
        federationCanonicalJson(row.payload) !== federationCanonicalJson(input)
      )
        throw new Error("Handoff mismatch");
      output(s, row, [`${s.t("saved")}: ${row.eventId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });

  const exports = media.command("exports").description("Approve and produce encrypted packages");
  const imports = media
    .command("imports")
    .description("Receive packages and authorize private imports");
  const exportPath = (id: string) => `${mediaBase}/exports/${z.uuid().parse(id)}`;
  const importPath = (id: string, authorization?: string) =>
    `${mediaBase}/packages/${z.uuid().parse(id)}${authorization ? `/import-authorizations/${z.uuid().parse(authorization)}` : ""}`;
  const sameFields = (row: object, expected: object) => {
    if (
      Object.entries(expected).some(([key, value]) =>
        key === "expiresAt" && typeof value === "string"
          ? Date.parse(Reflect.get(row, key)) !== Date.parse(value)
          : Reflect.get(row, key) !== value,
      )
    )
      throw new Error("Media response does not match the original request");
  };
  const mediaWrite = async (s: Session, path: string, input: unknown) => {
    try {
      return z.object({ success: z.literal(true) }).parse(await s.client.post(path, input));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  };
  for (const [commands, path, schema] of [
    [exports, "exports", MediaExportSummarySchema],
    [imports, "packages", MediaPackageSummarySchema],
  ] as const) {
    const list = page(commands.command("list"));
    action(list, async () => {
      const s = scoped();
      const rows = await get(s, `${mediaBase}/${path}?${query(list.opts())}`, z.array(schema));
      output(
        s,
        rows,
        rows.length
          ? rows.map((row) => {
              const state = row.revokedAt
                ? s.t("revokedState")
                : "expiresAt" in row
                  ? s.t(Date.parse(row.expiresAt) <= Date.now() ? "expired" : "active")
                  : s.t("saved");
              return `${row.packageId}\t${row.manifestDigest}\t${state}`;
            })
          : [s.t("empty")],
      );
    });
    action(commands.command("revoke <packageId> <file>"), async (packageId, file) => {
      const s = scoped(),
        input = FederationMediaRevocationSchema.parse(JSON.parse(await readInput(file)));
      const value = await mediaWrite(
        s,
        `${mediaBase}/${path}/${z.uuid().parse(packageId)}/revoke`,
        input,
      );
      output(s, value, [s.t("revoked")]);
    });
  }
  action(exports.command("show <packageId>"), async (packageId) => {
    const s = scoped(),
      row = await get(s, exportPath(packageId), MediaExportDetailSchema);
    sameFields(row, { packageId });
    output(s, row, [
      row.packageId,
      `${row.manifest.subject.kind}\t${row.manifestDigest}`,
      `${row.manifest.files.length} files\t${row.expiresAt}`,
    ]);
  });
  action(exports.command("approve <file>"), async (file) => {
    const s = scoped(),
      input = FederationAnyMediaExportApprovalSchema.parse(JSON.parse(await readInput(file)));
    try {
      const row = await post(s, `${mediaBase}/exports`, input, MediaExportDetailSchema);
      sameFields(row, {
        packageId: input.packageId,
        agreementRevisionId: input.agreementRevisionId,
        recipientSiteId: input.recipientSiteId,
        expiresAt: input.expiresAt,
      });
      if ("kind" in input) {
        if (!row.taskSelection) throw new Error("Missing task selector");
        sameFields(row.taskSelection, {
          kind: input.kind,
          operationId: input.operationId,
          agentId: input.agentId,
        });
      } else sameFields(row, { versionId: input.versionId, locationId: input.locationId });
      output(s, row, [`${s.t("saved")}: ${row.packageId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  action(
    exports
      .command("manifest <packageId> <file>")
      .description("Save registration JSON, without overwriting files"),
    async (packageId, file) => {
      const s = scoped(),
        row = await get(s, exportPath(packageId), MediaExportDetailSchema);
      sameFields(row, { packageId });
      const registration = FederationMediaRegistrationSchema.parse({
        senderSiteId: row.manifest.senderSiteId,
        signedManifest: row.signedManifest,
      });
      await save(file, registration);
      output(s, { packageId, file }, [`${s.t("saved")}: ${file}`]);
    },
  );
  for (const command of ["run", "status"] as const) {
    action(exports.command(`${command} <packageId>`), async (packageId) => {
      const s = scoped(),
        path = `${exportPath(packageId)}/${command === "run" ? "run" : "operation"}`;
      const row =
        command === "run"
          ? await post(
              s,
              path,
              {},
              MediaExportOperationSchema.refine((row) => row.packageId === packageId),
            )
          : await get(s, path, MediaExportOperationSchema.nullable());
      if (row) sameFields(row, { packageId });
      output(s, row, [row ? `${row.packageId}\t${row.state}\t${row.updatedAt}` : s.t("empty")]);
    });
  }
  const exportReceipts = page(exports.command("receipts <packageId>"));
  action(exportReceipts, async (packageId) => {
    const s = scoped(),
      rows = await get(
        s,
        `${exportPath(packageId)}/receipts?${query(exportReceipts.opts())}`,
        z.array(MediaRecordedReceiptSchema),
      );
    for (const row of rows) sameFields(row.receipt, { packageId });
    output(
      s,
      rows,
      rows.length
        ? rows.map(
            ({ receipt, acknowledgement }) =>
              `${receipt.receiptId}\t${receipt.generation}\t${receipt.state}\t${acknowledgement.recordedAt}`,
          )
        : [s.t("empty")],
    );
  });
  const importShow = imports
    .command("show <packageId>")
    .option("--authorization-offset <count>", "Authorization page offset", "0");
  action(importShow, async (packageId) => {
    const s = scoped(),
      offset = z.coerce.number().int().nonnegative().parse(importShow.opts().authorizationOffset);
    const row = await get(
      s,
      `${importPath(packageId)}?authorizationOffset=${offset}`,
      MediaPackageDetailSchema,
    );
    sameFields(row, { packageId });
    output(s, row, [
      row.packageId,
      `${row.subject.kind}\t${row.sizeBytes} B\t${row.manifestDigest}`,
      ...row.authorizations.map(
        (a) =>
          `${a.authorizationId}\t${a.agentId}\t${a.managedRootId}\t${a.revokedAt ? s.t("revokedState") : a.expiresAt}`,
      ),
      ...(row.hasMoreAuthorizations
        ? [
            s.lang === "zh"
              ? "还有批准记录；使用 --authorization-offset"
              : "More authorizations; use --authorization-offset",
          ]
        : []),
    ]);
  });
  action(imports.command("register <file>"), async (file) => {
    const s = scoped(),
      input = FederationMediaRegistrationSchema.parse(JSON.parse(await readInput(file)));
    try {
      const row = await post(s, `${mediaBase}/packages`, input, MediaPackageSummarySchema);
      sameFields(row, { senderSiteId: input.senderSiteId });
      output(s, row, [`${s.t("saved")}: ${row.packageId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  action(imports.command("approve <packageId> <file>"), async (packageId, file) => {
    const s = scoped(),
      input = FederationMediaImportApprovalSchema.parse(JSON.parse(await readInput(file)));
    try {
      const row = await post(
        s,
        `${importPath(packageId)}/import-authorizations`,
        input,
        MediaImportAuthorizationSchema,
      );
      sameFields(row, { ...input, packageId });
      output(s, row, [`${s.t("saved")}: ${row.authorizationId}`]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(s.t("unknown"));
    }
  });
  for (const command of ["run", "status"] as const) {
    action(
      imports.command(`${command} <packageId> <authorizationId>`),
      async (packageId, authorizationId) => {
        const s = scoped(),
          path = `${importPath(packageId, authorizationId)}/${command === "run" ? "run" : "operation"}`;
        const row =
          command === "run"
            ? await post(
                s,
                path,
                {},
                MediaImportOperationSchema.refine((row) => row.authorizationId === authorizationId),
              )
            : await get(s, path, MediaImportOperationSchema.nullable());
        if (row) sameFields(row, { authorizationId });
        output(s, row, [
          row
            ? `${row.authorizationId}\t${row.state === "verified" ? "verified-private" : row.state}\t${row.updatedAt}`
            : s.t("empty"),
        ]);
      },
    );
  }
  action(
    imports.command("receipt <packageId> <authorizationId>"),
    async (packageId, authorizationId) => {
      const s = scoped(),
        row = await get(
          s,
          `${importPath(packageId, authorizationId)}/receipt`,
          MediaImportReceiptViewSchema,
        );
      if (row.receipt) sameFields(row.receipt, { packageId });
      if (row.acknowledgement)
        sameFields(row.acknowledgement, { packageId, receiptId: row.receipt?.receiptId });
      output(s, row, [`${authorizationId}\t${row.state}`]);
    },
  );
  action(
    imports.command("retry-receipt <packageId> <authorizationId>"),
    async (packageId, authorizationId) => {
      const s = scoped(),
        value = await mediaWrite(s, `${importPath(packageId, authorizationId)}/receipt/retry`, {});
      output(s, value, [s.t("retry")]);
    },
  );
  action(
    imports.command("revoke-authorization <packageId> <authorizationId> <file>"),
    async (packageId, authorizationId, file) => {
      const s = scoped(),
        input = FederationMediaRevocationSchema.parse(JSON.parse(await readInput(file)));
      const value = await mediaWrite(s, `${importPath(packageId, authorizationId)}/revoke`, input);
      output(s, value, [s.t("revoked")]);
    },
  );

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
        kind = z.enum(["bill", "settlement", "refund"]).parse(rawKind),
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
  for (const kind of ["bill", "settlement", "adjustment", "refund", "payment"] as const) {
    const group = root.command(`${kind}s`);
    const list = page(
      group.command("list <revision>").option("--record <uuid>", "Filter the original record"),
    );
    if (kind === "payment")
      list
        .option("--bill <uuid>", "Filter original bill")
        .option("--payment <uuid>", "Show all statements for one payment");
    action(list, async (revision) => {
      const s = scoped(),
        c = await contract(s, revision),
        record = z.uuid().optional().parse(list.opts().record);
      const billFilter =
        kind === "payment" ? z.uuid().optional().parse(list.opts().bill) : undefined;
      const paymentFilter =
        kind === "payment" ? z.uuid().optional().parse(list.opts().payment) : undefined;
      const path = `${base(c)}/${kind}s?${query(list.opts())}${record ? `&recordId=${record}` : ""}${billFilter ? `&billId=${billFilter}` : ""}${paymentFilter ? `&paymentId=${paymentFilter}` : ""}`;
      if (kind === "payment") {
        const view = await get(s, path, CommercialPaymentListSchema);
        for (const { payment } of view.data) {
          checkScope(payment, c);
          checkRecordIdentity(payment);
          checkBusiness(kind, payment.payload, c);
          if (
            (record && record !== payment.receiptId) ||
            (billFilter && billFilter !== payment.billId) ||
            (paymentFilter && paymentFilter !== payment.paymentId)
          )
            throw new Error(s.t("scope"));
        }
        output(
          s,
          view,
          view.data.length
            ? view.data.map(
                ({ payment, ledger }) =>
                  `${payment.receiptId}\t${payment.payload.amount} ${payment.payload.unit}\n  ${s.t("signatures")}: ${payment.counterpartyJws ? s.t("both") : s.t("local")}\t${s.t("statement")}: ${payment.current ? s.t("current") : payment.confirmedAt ? s.t("superseded") : s.t("unconfirmed")}\t${s.t("ledger")}: ${c.terms.agreement.mode === "bilateral_direct" ? s.t("notRequired") : ledger ? s.t(ledger.state) : s.t(c.localSiteId === c.terms.agreement.targetSiteId ? "noRecord" : "unknownLedger")}`,
              )
            : [s.t("empty")],
        );
      } else if (kind === "bill") {
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
      } else if (kind === "settlement") {
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
      } else if (kind === "refund") {
        const view = await get(s, path, CommercialRefundListSchema);
        for (const row of view.data) {
          checkScope(row, c);
          checkRecordIdentity(row);
          checkBusiness(kind, row.payload, c);
          if (record && record !== row.refundId) throw new Error(s.t("scope"));
        }
        output(
          s,
          view,
          view.data.length
            ? view.data.map(
                (row) =>
                  `${row.refundId}\t${s.t("released")}: ${row.payload.releasedAmount} ${row.payload.request.unit}\n  ${s.t("signatures")}: ${row.counterpartyJws ? s.t("both") : s.t("local")}\t${s.t("accounting")}: ${row.appliedAt ? s.t("applied") : s.t("unapplied")}\t${s.t("ledger")}: ${c.terms.agreement.mode === "bilateral_direct" ? s.t("notRequired") : row.ledger ? s.t(row.ledger.state) : s.t(c.localSiteId === c.terms.agreement.targetSiteId ? "noRecord" : "unknownLedger")}`,
              )
            : [s.t("empty")],
        );
      } else {
        const view = await get(s, path, CommercialAdjustmentListSchema);
        for (const { adjustment } of view.data) {
          checkScope(adjustment, c);
          checkRecordIdentity(adjustment);
          checkBusiness(kind, adjustment.payload, c);
          if (record && record !== adjustment.adjustmentId) throw new Error(s.t("scope"));
        }
        output(
          s,
          view,
          view.data.length
            ? view.data.map(
                ({ adjustment, ledger }) =>
                  `${adjustment.adjustmentId}\t${s.t("previousCharge")}: ${adjustment.payload.previousChargedAmount}\t${s.t("newCharge")}: ${adjustment.payload.chargedAmount} ${c.terms.agreement.unit}\n  ${s.t("held")}: ${adjustment.heldAmount}\t${s.t("signatures")}: ${adjustment.counterpartyJws ? s.t("both") : s.t("local")}\t${s.t("accounting")}: ${adjustment.appliedAt ? s.t("applied") : s.t("unapplied")}\t${s.t("ledger")}: ${c.terms.agreement.mode === "bilateral_direct" ? s.t("notRequired") : ledger ? s.t(ledger.state) : s.t("noRecord")}`,
              )
            : [s.t("empty")],
        );
      }
    });
    const draft = group
      .command("draft <revision> <reference> <file>")
      .description(
        `Generate a ${kind} draft from ${kind === "bill" ? "report ID" : (kind === "settlement" || kind === "payment") ? "bill ID" : kind === "refund" ? "operation ID" : "settlement ID"}; never approves`,
      )
      .option("--id <uuid>", "Original draft ID");
    if (kind === "adjustment")
      draft
        .requiredOption(
          "--amount <integer>",
          "New net charge in contract units (not the difference)",
        )
        .requiredOption("--reason <text>", "Reason reviewed by both institutions")
        .option("--evidence <digest>", "SHA-256 digest of supporting evidence");
    if (kind === "refund")
      draft.requiredOption("--reason <text>", "Reason reviewed by both institutions");
    if (kind === "payment")
      draft
        .option("--payment <uuid>", "Original payment ID for corrections; new ID when omitted")
        .requiredOption("--amount <integer>", "Full acknowledged amount, not a correction delta")
        .requiredOption("--occurred-at <iso>", "External payment time in ISO 8601 UTC")
        .requiredOption("--evidence <digest>", "SHA-256 digest of controlled payment evidence")
        .requiredOption("--reason <text>", "Acknowledgement or correction reason");
    action(draft, async (revision, reference, file) => {
      const s = scoped(),
        ref = z.uuid().parse(reference),
        id = z.uuid().parse(draft.opts().id ?? crypto.randomUUID()),
        c = await contract(s, revision);
      const input =
        kind === "payment"
          ? CommercialPaymentDraftInputSchema.parse({
              receiptId: id,
              paymentId: draft.opts().payment ?? crypto.randomUUID(),
              billId: ref,
              amount: draft.opts().amount,
              occurredAt: draft.opts().occurredAt,
              evidenceDigest: draft.opts().evidence,
              reason: draft.opts().reason,
            })
          : kind === "bill"
            ? { reportId: ref, billId: id }
            : kind === "settlement"
              ? { billId: ref, settlementId: id }
              : kind === "refund"
                ? CommercialRefundDraftInputSchema.parse({
                    operationId: ref,
                    refundId: id,
                    reason: draft.opts().reason,
                  })
                : CommercialAdjustmentDraftInputSchema.parse({
                    settlementId: ref,
                    adjustmentId: id,
                    chargedAmount: draft.opts().amount,
                    reason: draft.opts().reason,
                    supportingEvidenceDigest: draft.opts().evidence ?? null,
                  });
      const value = checkBusiness(
        kind,
        await post(s, `${base(c)}/${kind}s/draft`, input, businessSchemas[kind]),
        c,
      );
      if (
        value.kind === "commercial-payment"
          ? federationCanonicalJson({
              receiptId: value.receiptId,
              paymentId: value.paymentId,
              billId: value.billId,
              amount: value.amount,
              occurredAt: value.occurredAt,
              evidenceDigest: value.evidenceDigest,
              reason: value.reason,
            }) !== federationCanonicalJson(input)
          : value.kind === "commercial-bill"
            ? value.billId !== id || value.reportId !== ref
            : value.kind === "commercial-settlement"
              ? value.settlementId !== id || value.billId !== ref
              : value.kind === "commercial-refund"
                ? value.refundId !== id ||
                  value.request.operationId !== ref ||
                  value.reason !== CommercialRefundDraftInputSchema.parse(input).reason
                : value.adjustmentId !== id ||
                  value.settlementId !== ref ||
                  federationCanonicalJson({
                    settlementId: value.settlementId,
                    adjustmentId: value.adjustmentId,
                    chargedAmount: value.chargedAmount,
                    reason: value.reason,
                    supportingEvidenceDigest: value.supportingEvidenceDigest,
                  }) !== federationCanonicalJson(input)
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
        const row = await post(s, `${base(c)}/${kind}s/approve`, input, approvalSchemas[kind]);
        try {
          checkScope(row, c);
          checkRecordIdentity(row);
          if (federationCanonicalJson(row.payload) !== federationCanonicalJson(input))
            throw new Error("Changed approval response");
        } catch {
          throw new Error(s.t("unknown"));
        }
        output(s, row, [s.t("approved"), recordId(row.payload)]);
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
          approvalSchemas[kind],
        );
        try {
          checkScope(row, c);
          checkRecordIdentity(row);
          checkBusiness(kind, row.payload, c);
          if (recordId(row.payload) !== id || row.counterpartyJws !== approvalJws)
            throw new Error("Changed counterparty response");
        } catch {
          throw new Error(s.t("unknown"));
        }
        output(s, row, [s.t("attached")]);
      },
    );
  }
}
