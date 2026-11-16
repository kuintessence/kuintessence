import { useState } from "react";
import { createRoot } from "react-dom/client";
import catalog from "../src/components/function-maps/catalog.json";
import { FunctionMapView } from "../src/components/function-maps/FunctionMapView";
import { type FunctionMap, mapText } from "../src/components/function-maps/model";
import {
  authorizationRuntime,
  infrastructureRuntime,
} from "../src/components/function-maps/runtime";
import { NativeSelect } from "../src/components/ui/native-select";
import { PageHeader, PageShell } from "../src/components/ui/page";
import { setLang } from "../src/lib/i18n";
import "./function-maps.css";
const models = catalog as FunctionMap[];
const params = new URLSearchParams(window.location.search);
function Preview() {
  const [id, setId] = useState(params.get("map") ?? "G12");
  const [language, setLanguage] = useState(params.get("language") ?? "zh");
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [state, setState] = useState("ready");
  const [opened, setOpened] = useState("");
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.lang = language;
  const model = models.find((item) => item.id === id) ?? models[0];
  if (!model) return null;
  const demo =
    id === "G05"
      ? infrastructureRuntime({
          agents:
            state === "ready"
              ? [
                  {
                    id: "demo-agent-01",
                    hostname: "本地演示节点 / Demo Agent",
                    siteId: "demo-site",
                    status: "online",
                  },
                ]
              : [],
          state:
            state === "ready"
              ? "ready"
              : state === "loading"
                ? "loading"
                : state === "forbidden"
                  ? "forbidden"
                  : "error",
          overviewState: "no-data",
          fetchedAt: Date.parse("2026-11-15T00:00:00Z"),
          overviewFetchedAt: 0,
        })
      : id === "T01"
        ? authorizationRuntime({
            state:
              state === "ready"
                ? "ready"
                : state === "loading"
                  ? "loading"
                  : state === "forbidden"
                    ? "forbidden"
                    : "error",
            health: {
              mode: "shadow",
              configured: true,
              healthy: true,
              schemaMatches: true,
              schemaWritten: true,
              outbox: { pending: 2, processing: 1, dead: 1 },
            },
            readiness: {
              outbox: { pending: 2, processing: 1, dead: 1 },
              shadowDiffs: 3,
              enforceReady: false,
              blockers: [],
              externalSmokeRequired: true,
            },
            fetchedAt: "2026-11-15T00:00:00Z",
          })
        : undefined;
  const graph = demo?.nodes ? { ...model, nodes: demo.nodes, edges: demo.edges ?? [] } : model;
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
      <p className="text-sm text-muted-foreground">
        本地组件验收 · 使用正式组件与主题 · 运行状态为明确标记的模拟数据 · 不连接平台、不执行操作
      </p>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 max-w-full text-sm">
          示意图{" "}
          <NativeSelect
            aria-label="Map"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setOpened("");
            }}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} {mapText(item.title, language)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="min-w-0 max-w-full text-sm">
          语言{" "}
          <NativeSelect
            aria-label="Language"
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              setLang(event.target.value === "en" ? "en" : "zh");
            }}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </NativeSelect>
        </label>
        <label className="min-w-0 max-w-full text-sm">
          主题{" "}
          <NativeSelect
            aria-label="Theme"
            value={dark ? "dark" : "light"}
            onChange={(event) => setDark(event.target.value === "dark")}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </NativeSelect>
        </label>
        {demo ? (
          <label className="min-w-0 max-w-full text-sm">
            模拟获取状态{" "}
            <NativeSelect
              aria-label="Demo state"
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              <option value="ready">已获取</option>
              <option value="loading">加载中</option>
              <option value="forbidden">无权限</option>
              <option value="error">获取失败</option>
            </NativeSelect>
          </label>
        ) : null}
      </div>
      <PageShell>
        <PageHeader title={mapText(model.title, language)} />
        <FunctionMapView
          key={`${id}:${language}:${state}`}
          model={graph}
          language={language}
          runtime={demo}
          onOpen={(node) =>
            setOpened(`本地预览入口（不跳转）：${node.route} ${mapText(node.section, language)}`)
          }
        />
        {opened ? <p role="status">{opened}</p> : null}
      </PageShell>
    </main>
  );
}
setLang(params.get("language") === "en" ? "en" : "zh");
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
