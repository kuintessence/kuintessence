# SPDX-License-Identifier: MIT
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
import importlib.util
module_spec = importlib.util.spec_from_file_location('business_catalog', Path(__file__).resolve().parents[1] / 'scripts/ecosystem-revise-catalog.py')
assert module_spec is not None and module_spec.loader is not None
module = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(module)
revise, canonical = module.revise, module.canonical

class BusinessCatalogTests(unittest.TestCase):
    def test_revision_preserves_execution_and_rebinds_nested_graph(self):
        script='print("immutable science")\n'
        command='solver --input input.dat > result.dat'
        manifest={'schemaVersion':1,'releaseKey':'catalog','version':'old','materialRequirements':[{'binding':'unchanged'}],'assets':[
            {'ecosystemKey':'software','kind':'spack-package','name':'solver','version':'1','payload':{'spack':{'defaultSpec':'solver@1','metadata':{}}},'provenance':{'sourceSha256':'abc'}},
            {'ecosystemKey':'script','kind':'sandbox-script','name':'prepare','version':'old','payload':{'content':script,'sha256':hashlib.sha256(script.encode()).hexdigest()},'provenance':{}},
            {'ecosystemKey':'case','kind':'usecase','name':'old-case','version':'old','payload':{'spec':{'description':'old','softwareRef':{'source':'platform-fork','name':'solver','version':'1'},'inputs':[{'default':command}]}},'provenance':{}},
            {'ecosystemKey':'workflow','kind':'workflow-template','name':'flow','version':'old','payload':{'yamlContent':json.dumps({'name':'flow','parameters':[{'default':command}],'spec':{'nodeDrafts':[{'type':'Script','scriptRef':{'name':'prepare','version':'old'}},{'type':'SoftwareUsecaseComputing','usecaseRef':{'name':'old-case','version':'old'},'softwareRef':{'name':'solver','version':'1'}}]}})},'provenance':{}}]}
        original=copy.deepcopy(manifest)
        result=revise(manifest,{'case':{'name':'Sequence processing','description':'Reads input and produces result.'},'workflow':{'description':'Business workflow'}},'new')
        self.assertEqual(manifest,original)
        self.assertEqual(result['materialRequirements'],original['materialRequirements'])
        self.assertEqual(result['assets'][0],original['assets'][0])
        self.assertEqual(result['assets'][1]['payload'],original['assets'][1]['payload'])
        case=result['assets'][2]
        self.assertEqual(case['payload']['spec']['inputs'][0]['default'],command)
        self.assertEqual(case['specDigest'],'sha256:'+hashlib.sha256(canonical(case['payload']['spec']).encode()).hexdigest())
        flow=json.loads(result['assets'][3]['payload']['yamlContent'])
        self.assertEqual(flow['parameters'][0]['default'],command)
        nodes=flow['spec']['nodeDrafts']
        self.assertEqual(nodes[0]['scriptRef'],{'name':'prepare','version':'new'})
        self.assertEqual(nodes[1]['usecaseRef'],{'name':'Sequence processing','version':'new'})
        self.assertEqual(nodes[1]['softwareRef'],{'name':'solver','version':'1'})

    def test_rejects_unknown_identity_and_execution_override(self):
        manifest={'assets':[{'ecosystemKey':'a','kind':'usecase','name':'a','version':'1','payload':{'spec':{}},'provenance':{}}]}
        with self.assertRaises(ValueError): revise(manifest,{'unknown':{}},'2')
        with self.assertRaises(ValueError): revise(manifest,{'a':{'command':'changed'}},'2')

if __name__=='__main__':unittest.main()
