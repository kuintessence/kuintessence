# SPDX-License-Identifier: MIT
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CLI = Path(__file__).resolve().parents[1] / "scripts/ecosystem-revise-catalog.py"
POLICY = {
    "classification": "open-source", "identifiers": [{"kind": "spdx", "value": "MIT"}],
    "provenance": {"source": "official-upstream", "reference": "https://example.test/license"},
    "autoInstall": "allowed",
}


def selector(name):
    return {"source": "platform-fork", "name": name, "version": "1"}


def asset(key, kind, name, **payload):
    return {"ecosystemKey": key, "kind": kind, "name": name, "version": "1",
            "payload": {"kind": kind, **payload}, "licensePolicy": POLICY, "provenance": {}}


def manifest(site_kind="Bare"):
    software = selector("solver")
    site = {"kind": site_kind}
    if site_kind == "Singularity":
        site.update(image="solver", tag="1")
    spack = {"kind": "Spack", "name": "solver", "argumentList": []}
    immutable = {"softwareRef": software, "scriptRef": selector("prepare"), "limit": 1e-7}
    assets = [
        asset("spack", "spack-package", "solver", spack={"packageName": "solver", "defaultSpec": "solver@1"}),
        asset("site", "site-runtime", "solver", siteIds=["site-a"],
              runtime={**site, "path": "/opt/test/solve" if site_kind == "Bare" else "/opt/test/solve.sif", "sha256": "a" * 64}),
    ]
    nodes = []
    for name, facility, kind in [("local", site, "site-runtime"), ("managed", spack, "spack-package")]:
        spec = {
            "description": "Compute", "domain": "test", "tags": [], "citations": [],
            "softwareRef": software, "software": facility, "usecase": {"commandFile": "solve", "inputSlots": []},
            "inputs": [{"descriptor": "sample", "type": "String", "default": immutable}],
            "outputs": [], "resources": {}, "materialMappings": [], "licenseRequirements": [],
            "arguments": [], "environments": [], "filesomeInputs": [], "filesomeOutputs": [], "valueOutputs": [],
        }
        assets.append(asset(name, "usecase", name, spec=spec, packageRefs=[{"kind": kind, **software}]))
        nodes.append({"type": "SoftwareUsecaseComputing", "name": name, "id": name,
                      "usecaseRef": selector(name), "softwareRef": software})
    contract = {"name": "python-3.12-stdlib-v1", "version": "1"}
    content = "print('unchanged')\n"
    assets.append(asset("script", "sandbox-script", "prepare", language="python", runtimeContractRef=contract,
                        executionIdentity={"type": "MappedAuto"}, entrypoint="main.py", content=content,
                        sha256=hashlib.sha256(content.encode()).hexdigest()))
    hook = {"scriptRef": selector("prepare"), "runtimeContractRef": contract, "executionIdentity": {"type": "MappedAuto"}}
    nodes[0]["hooks"] = {"pre": hook, "post": hook}
    nodes.append({"type": "Script", "id": "prepare", "name": "prepare", "scriptRef": selector("prepare"),
                  "runtimeContractRef": contract, "executionIdentity": {"type": "MappedAuto"},
                  "schedulingStrategy": {"type": "Auto"}, "inputs": {}, "outputs": {}})
    nodes.append({"type": "Generate", "id": "sample", "name": "sample",
                  "rule": {"kind": "Enumeration", "values": [1]}, "output": {"as": "List", "descriptor": "out"}})
    summaries = [{"type": "Reduce", "id": "summary_" + key, "name": key,
                  "from": {"loop": "loop", "output": "items"}, "output": {"kind": "Value", "descriptor": "result"},
                  "reducer": {"kind": "Command", **binding}} for key, binding in [
                      ("local", {"usecaseRef": selector("local"), "softwareRef": software}),
                      ("managed", {"usecaseRef": selector("managed"), "softwareRef": software}),
                      ("script", {"script": hook})]]
    loop = {"type": "Loop", "id": "loop", "name": "repeat", "mode": "ForEach", "over": {"expr": "[1]"},
            "maxIterations": 1, "body": {"nodeDrafts": nodes},
            "outputs": [{"descriptor": "items", "from": {"node": "sample", "output": "out"}, "aggregate": "Collect"}]}
    workflow = {"name": "flow", "parameters": [{"name": "sample", "type": "json", "default": immutable}],
                "spec": {"nodeDrafts": [{"type": "SubWorkflow", "id": "sub", "name": "sub", "maxDepth": 1,
                                         "ref": {"kind": "Inline", "body": {"nodeDrafts": [loop, *summaries]}}}]}}
    external = {"kind": "site-runtime", **software, "source": "cp-shared"}
    pinned = {"kind": "site-runtime", **software, "id": "11111111-1111-4111-8111-111111111111"}
    assets.append(asset("flow", "workflow-template", "flow", packageRefs=[external, pinned],
                        yamlContent=json.dumps(workflow)))
    return {"schemaVersion": 1, "releaseKey": "catalog-test", "version": "1", "provenance": {}, "assets": assets}


class BusinessCatalogTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.output = self.root / "output.json"

    def run_cli(self, data, changes):
        (self.root / "input.json").write_text(json.dumps(data))
        (self.root / "metadata.json").write_text(json.dumps(changes))
        return subprocess.run([sys.executable, str(CLI), "input.json", "metadata.json", "output.json", "--version", "2"],
                              cwd=self.root, capture_output=True, text=True)

    def test_rebinds_governed_selectors_and_preserves_execution(self):
        for kind in ("Bare", "Singularity"):
            with self.subTest(kind=kind):
                original = manifest(kind)
                # A YAML alias may appear in both execution data and a catalog selector.
                flow_payload = original["assets"][-1]["payload"]
                workflow = json.loads(flow_payload["yamlContent"])
                default = workflow["parameters"][0]["default"]
                selector_text = json.dumps(default["softwareRef"])
                parameters = json.dumps(workflow["parameters"]).replace(selector_text, "&software " + selector_text)
                flow_payload["yamlContent"] = ("name: flow\nparameters: " + parameters + "\nspec: "
                                              + json.dumps(workflow["spec"]).replace(selector_text, "*software "))
                changes = {"spack": {"name": "Managed solver"}, "site": {"name": "Site solver"},
                           "local": {"name": "Site case", "description": "Updated"}, "script": {"name": "Prepare input"}}
                run = self.run_cli({"manifest": original}, changes)
                self.assertEqual(run.returncode, 0, run.stderr)
                result = json.loads(self.output.read_text())
                self.assertEqual(result["version"], "2")
                assets = {a["ecosystemKey"]: a for a in result["assets"]}
                self.assertEqual(assets["spack"]["payload"], original["assets"][0]["payload"])
                self.assertEqual(assets["site"]["payload"], original["assets"][1]["payload"])
                self.assertEqual(assets["flow"]["payload"]["packageRefs"], flow_payload["packageRefs"])
                self.assertEqual(assets["script"]["payload"], original["assets"][4]["payload"])
                flow = json.loads(assets["flow"]["payload"]["yamlContent"])
                nodes = flow["spec"]["nodeDrafts"][0]["ref"]["body"]["nodeDrafts"][0]["body"]["nodeDrafts"]
                self.assertEqual(nodes[0]["usecaseRef"], {**selector("Site case"), "version": "2"})
                self.assertEqual(nodes[2]["scriptRef"], {**selector("Prepare input"), "version": "2"})
                _, local, managed, script = flow["spec"]["nodeDrafts"][0]["ref"]["body"]["nodeDrafts"]
                for node, summary in zip(nodes, [local, managed]):
                    self.assertEqual(summary["reducer"]["usecaseRef"], node["usecaseRef"])
                    self.assertEqual(summary["reducer"]["softwareRef"], node["softwareRef"])
                self.assertEqual(script["reducer"]["script"], nodes[0]["hooks"]["pre"])
                for hook in nodes[0]["hooks"].values():
                    self.assertEqual(hook["scriptRef"], nodes[2]["scriptRef"])
                    self.assertEqual(hook["runtimeContractRef"], nodes[2]["runtimeContractRef"])
                for index, (key, name) in enumerate([("local", "Site solver"), ("managed", "Managed solver")]):
                    case = assets[key]
                    spec = case["payload"]["spec"]
                    self.assertEqual(spec["softwareRef"], selector(name))
                    self.assertEqual(nodes[index]["softwareRef"], selector(name))
                    self.assertEqual(case["payload"]["packageRefs"][0]["name"], name)
                    self.assertEqual(spec["inputs"], original["assets"][index + 2]["payload"]["spec"]["inputs"])
                    # ECMAScript writes this exponential default as 1e-7.
                    encoded = json.dumps(spec, sort_keys=True, separators=(",", ":")).replace("1e-07", "1e-7")
                    self.assertEqual(case["specDigest"], "sha256:" + hashlib.sha256(encoded.encode()).hexdigest())
                self.assertEqual(flow["parameters"][0]["default"], spec["inputs"][0]["default"])
                self.assertNotEqual(self.run_cli(original, changes).returncode, 0)
                self.assertEqual(json.loads(self.output.read_text()), result)
                self.output.unlink()

    def test_rejects_hooks_with_missing_script_or_incompatible_contract(self):
        for missing, message in [(True, "must resolve exactly once"), (False, "runtime contract differs")]:
            with self.subTest(missing=missing):
                data = manifest()
                payload = data["assets"][-1]["payload"]
                flow = json.loads(payload["yamlContent"])
                case = flow["spec"]["nodeDrafts"][0]["ref"]["body"]["nodeDrafts"][0]["body"]["nodeDrafts"][0]
                if missing:
                    case["hooks"]["pre"]["scriptRef"]["name"] = "unknown"
                else:
                    data["assets"][4]["payload"]["runtimeContractRef"]["version"] = "2"
                payload["yamlContent"] = json.dumps(flow)
                run = self.run_cli(data, {})
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(message, run.stderr)
                self.assertFalse(self.output.exists())

    def test_rejects_invalid_command_bindings(self):
        fixed = {"usecaseVersionId": "11111111-1111-4111-8111-111111111111",
                 "softwareVersionId": "22222222-2222-4222-8222-222222222222"}
        for index, patch, error in [
            (1, {"usecaseRef": fixed}, "must use named usecase"),
            (1, {"usecaseRef": selector("local"), "softwareRef": selector("other")}, "softwareRef differs"),
            (3, {"script": {"scriptRef": selector("missing"), "runtimeContractRef": {"name": "python", "version": "1"}}}, "must resolve exactly once"),
            (3, {"script": {"scriptRef": selector("prepare"), "runtimeContractRef": {"name": "python", "version": "1"}}}, "runtime contract differs"),
            (3, {"script": {"scriptRef": selector("prepare"), "runtimeContractRef": {"name": "python-3.12-stdlib-v1", "version": "1"}}}, "MappedAuto"),
        ]:
            with self.subTest(index=index, error=error):
                data = manifest()
                payload = data["assets"][-1]["payload"]
                flow = json.loads(payload["yamlContent"])
                flow["spec"]["nodeDrafts"][0]["ref"]["body"]["nodeDrafts"][index]["reducer"] = {"kind": "Command", **patch}
                payload["yamlContent"] = json.dumps(flow)
                run = self.run_cli(data, {})
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(error, run.stderr)
                self.assertFalse(self.output.exists())

    def test_data_product_metadata_retains_delivery_terms_and_identity(self):
        data = manifest()
        product = {
            "kind": "licensed-material", "selector": "restricted-input", "version": "1",
            "description": "Input", "tags": [], "accessMode": "entitlement", "sensitivity": "restricted",
            "deliveryPolicy": {"download": "deny", "derive": "deny", "redistribution": "deny",
                               "crossCenterReplication": "deny", "retention": "source-controlled"},
            "redistribution": "prohibited", "entitlementRequired": True,
        }
        data["assets"].append(asset("input", "data-product", "Input", dataAsset=product))
        edits = {"description": "Reference input", "tags": ["reference"]}
        run = self.run_cli(data, {"input": edits})
        self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(self.output.read_text())["assets"][-1]
        self.assertEqual(result["payload"]["dataAsset"], {**product, **edits})
        self.assertEqual(result["licensePolicy"], data["assets"][-1]["licensePolicy"])

    def test_concurrent_revisions_publish_one_complete_manifest(self):
        (self.root / "input.json").write_text(json.dumps(manifest()))
        (self.root / "metadata.json").write_text("{}")
        processes = [
            subprocess.Popen([sys.executable, str(CLI), "input.json", "metadata.json", "output.json",
                              "--version", version], cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for version in ("2", "3")
        ]
        for process in processes:
            process.communicate(timeout=30)
        codes = [process.returncode for process in processes]
        self.assertEqual(codes.count(0), 1)
        result = json.loads(self.output.read_text())
        self.assertEqual(result["version"], ("2", "3")[codes.index(0)])
        self.assertEqual(len(result["assets"]), 6)
        self.assertEqual(list(self.root.glob(".catalog-*")), [])

    def test_rejects_invalid_revisions_before_writing(self):
        for changes, message in [({"missing": {}}, "Unknown ecosystem key"),
                                 ({"site": {"command": "other"}}, "Unrecognized key"),
                                 ({"local": {"name": "managed"}}, "Named selector is ambiguous")]:
            with self.subTest(changes=changes):
                run = self.run_cli(manifest(), changes)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn(message, run.stderr)
                self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
