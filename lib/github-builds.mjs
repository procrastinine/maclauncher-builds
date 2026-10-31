import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {bundleFromJSON} from '@sigstore/bundle';
import {ASN1Obj} from '@sigstore/core';
import {TrustedRoot} from '@sigstore/protobuf-specs';
import {Verifier,toSignedEntity,toTrustMaterial} from '@sigstore/verify';

const issuer='https://token.actions.githubusercontent.com';
const workflowPath='.github/workflows/runtime-build.yml';
const oidPrefix='1.3.6.1.4.1.57264.1.';
const trustFile=new URL('../attestations/trusted-root.jsonl',import.meta.url);
let defaultVerifiers;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function fail(message,options){throw Error('GitHub build provenance: '+message,options);}
function verifiers(trustedRoot){
 const roots=typeof trustedRoot==='string'||Buffer.isBuffer(trustedRoot)
  ? String(trustedRoot).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))
  : Array.isArray(trustedRoot)?trustedRoot:[trustedRoot];
 if(!roots.length||roots.some(root=>!root||typeof root!=='object'))fail('a trusted Sigstore root is required.');
 return roots.map(root=>new Verifier(toTrustMaterial(TrustedRoot.fromJSON(root)),
  {ctlogThreshold:1,tlogThreshold:1,timestampThreshold:1}));
}
function certificateString(identity,number){
 const matches=identity?.oids?.filter(entry=>entry.oid?.id.join('.')===oidPrefix+number)||[];
 if(matches.length!==1)fail('the signing certificate omits or repeats identity OID '+number+'.');
 const value=ASN1Obj.parseBuffer(Buffer.from(matches[0].value));
 if(!value.tag.isUniversal()||value.tag.number!==12||value.tag.constructed)fail('a certificate identity is not a UTF-8 string.');
 return new TextDecoder('utf-8',{fatal:true}).decode(value.value);
}

/** Verify a signed archive digest without downloading or executing the archive.
 * Trust roots are public Sigstore trust material authenticated through TUF.
 * All signatures, certificates, timestamps and log proofs are checked by Sigstore.
 * The optional root argument is an explicit caller trust configuration; ledger
 * data cannot choose it. No network or developer-local files are consulted.
 */
export function verifyBuildEvidence({record,repository,bundle,trustedRoot}={}){
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||''))fail('an explicit source repository is required.');
 if(!record||!record.id||!record.version||!['arm64','x64','universal'].includes(record.arch)||
  record.asset?.filename!==`${record.id}-${record.version}-${record.arch}.tar.gz`||
  !/^[a-f0-9]{64}$/.test(record.asset?.sha256||''))fail('the exact package identity and archive SHA-256 are required.');
 const parsed=bundleFromJSON(bundle);
 if(parsed.content.$case!=='dsseEnvelope'||parsed.content.dsseEnvelope.payloadType!=='application/vnd.in-toto+json')
  fail('a signed in-toto DSSE statement is required.');
 const workflow=repository+'/'+workflowPath,workflowURI='https://github.com/'+workflow;
 const policy={extensions:{issuer},subjectAlternativeName:'^'+escape(workflowURI)+'@(?:refs/[^\\s]+|[a-fA-F0-9]{40})$'};
 const entity=toSignedEntity(parsed);
 const selected=trustedRoot===undefined?(defaultVerifiers??=verifiers(fs.readFileSync(trustFile,'utf8'))):verifiers(trustedRoot);
 let signer,lastError;
 for(const verifier of selected){try{signer=verifier.verify(entity,policy);break;}catch(error){lastError=error;}}
 if(!signer)fail('signature, certificate, log or workflow verification failed.',{cause:lastError});
 const identity=signer.identity,sourceRevision=certificateString(identity,13);
 if(!/^[a-f0-9]{40}$/.test(sourceRevision))fail('the signing certificate has no exact source commit.');
 if(certificateString(identity,11)!=='github-hosted')fail('the signing runner was not GitHub-hosted.');
 if(certificateString(identity,12)!=='https://github.com/'+repository)fail('the certified source repository differs from the package repository.');
 const certifiedWorkflow=certificateString(identity,9);
 if(certifiedWorkflow!==identity.subjectAlternativeName||certificateString(identity,10)!==sourceRevision)
  fail('the signer workflow and source commit do not agree.');
 const runUrl=certificateString(identity,21);
 const run=new RegExp('^https://github\\.com/'+escape(repository)+'/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)$').exec(runUrl);
 if(!run)fail('the certificate has no build invocation in the source repository.');
 const sourceRef=certificateString(identity,14);
 const expectedSource=record.build?.sourceRevision||(record.source?.repository===repository?record.source.revision:undefined);
 if(expectedSource!==undefined&&expectedSource!==sourceRevision)fail('the recorded source commit differs from the certified source commit.');
 if(record.build?.workflow!==undefined&&record.build.workflow!==workflow)fail('the recorded workflow differs from Runtime build.');
 if(record.build?.runId!==undefined&&String(record.build.runId)!==run[1])fail('the recorded build run differs from the certified invocation.');
 if(record.build?.runAttempt!==undefined&&String(record.build.runAttempt)!==run[2])fail('the recorded build attempt differs from the certified invocation.');
 const statement=JSON.parse(Buffer.from(parsed.content.dsseEnvelope.payload).toString('utf8'));
 if(statement._type!=='https://in-toto.io/Statement/v1'||statement.predicateType!=='https://slsa.dev/provenance/v1')
  fail('the signed statement is not SLSA provenance v1.');
 const subjects=statement.subject?.filter(subject=>subject.name===record.asset.filename&&subject.digest?.sha256===record.asset.sha256);
 if(subjects?.length!==1)fail('the signed statement does not identify the exact archive and SHA-256.');
 const definition=statement.predicate?.buildDefinition,runDetails=statement.predicate?.runDetails;
 if(definition?.buildType!=='https://actions.github.io/buildtypes/workflow/v1'||
  definition.externalParameters?.workflow?.path!==workflowPath||
  definition.externalParameters?.workflow?.repository!=='https://github.com/'+repository||
  definition.externalParameters?.workflow?.ref!==sourceRef||
  !definition.resolvedDependencies?.some(dependency=>dependency.uri==='git+https://github.com/'+repository+'@'+sourceRef&&dependency.digest?.gitCommit===sourceRevision)||
  runDetails?.builder?.id!==certifiedWorkflow||runDetails?.metadata?.invocationId!==runUrl)
  fail('the signed provenance disagrees with the certified workflow, source or invocation.');
 return {repository,workflow,sourceRevision,sourceRef,runId:run[1],runAttempt:run[2],runUrl,
  runnerEnvironment:'github-hosted',filename:record.asset.filename,sha256:record.asset.sha256,
  attestationSha256:sha256(JSON.stringify(bundle))};
}
