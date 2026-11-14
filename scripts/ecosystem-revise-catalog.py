#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Create a new Ecosystem manifest from explicit business metadata changes.

The input is an unsigned manifest or a signed bundle. Signing is a separate step.
Only display metadata and catalog selectors may change; commands and materials
remain byte-for-byte unchanged. Stable ecosystem keys retain release identity.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def revise(manifest, metadata, version):
    result = copy.deepcopy(manifest)
    assets = result["assets"]
    keys = {a["ecosystemKey"] for a in assets}
    if set(metadata) - keys:
        raise ValueError("Metadata names unknown ecosystem keys")
    selectors = {}
    for asset in assets:
        change = metadata.get(asset["ecosystemKey"], {})
        if set(change) - {"name", "description", "tags", "domain"}:
            raise ValueError("Only name, description, tags and domain are editable")
        before = (asset["kind"], asset["name"], asset["version"])
        asset["name"] = change.get("name", asset["name"])
        if asset["kind"] in {"usecase", "workflow-template", "sandbox-script"}:
            asset["version"] = version
        selectors[before] = (asset["name"], asset["version"])

    def references(value):
        if isinstance(value, list):
            return [references(item) for item in value]
        if not isinstance(value, dict):
            return value
        updated = {}
        for key, item in value.items():
            if key in {"softwareRef", "usecaseRef", "scriptRef", "packageRefs", "usecaseRefs"}:
                kind = {"softwareRef": "spack-package", "usecaseRef": "usecase", "scriptRef": "sandbox-script", "packageRefs": "spack-package", "usecaseRefs": "usecase"}.get(key)
                def ref(entry):
                    mapped = selectors.get((entry.get("kind", kind), entry.get("name"), entry.get("version")))
                    if mapped:
                        return {**entry, "name": mapped[0], "version": mapped[1]}
                    return entry
                updated[key] = [ref(r) for r in item] if isinstance(item, list) else ref(item)
            else:
                updated[key] = references(item)
        return updated

    for asset in assets:
        change = metadata.get(asset["ecosystemKey"], {})
        payload = references(asset["payload"])
        if asset["kind"] == "usecase":
            spec = payload["spec"]
            for key in ("description", "tags", "domain"):
                if key in change:
                    spec[key] = change[key]
            asset["specDigest"] = "sha256:" + hashlib.sha256(canonical(spec).encode()).hexdigest()
        elif asset["kind"] == "workflow-template":
            # Parse through YAML in the CLI so JSON and YAML definitions share the same path.
            try:
                document = json.loads(payload["yamlContent"])
            except json.JSONDecodeError:
                import yaml
                document = yaml.safe_load(payload["yamlContent"])
            document = references(document)
            document["name"] = asset["name"]
            if "description" in change:
                document["description"] = change["description"]
            payload["yamlContent"] = json.dumps(document, ensure_ascii=False, indent=2)
        elif "description" in change:
            if asset["kind"] == "spack-package":
                payload["spack"].setdefault("metadata", {})["description"] = change["description"]
            else:
                # Sandbox schema has no mutable executable description field.
                asset["provenance"]["description"] = change["description"]
        asset["payload"] = payload
    result["version"] = version
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    original = json.loads(args.manifest.read_text())
    original = original.get("manifest", original)
    if original.get("schemaVersion") != 1:
        raise ValueError("Expected schemaVersion 1 Ecosystem manifest")
    result = revise(original, json.loads(args.metadata.read_text()), args.version)
    with args.output.open("x") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
