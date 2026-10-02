import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAcceptMerchantLegalPolicies,
  useGetCurrentLegalPolicies,
  useGetMerchantLegalConsent,
  useListAdminLegalPolicies,
  useListAdminLegalPolicyVersions,
  usePublishAdminLegalPolicy,
  useSaveAdminLegalPolicyDraft,
  type LegalPolicyAdmin,
  type LegalPolicyType,
} from '@workspace/api-client-react';
import { Async, Btn, Err, Field, Heading, Note, useAccess, useInvalidateAll } from '@/components/kit';

const policyLabels: Record<LegalPolicyType, string> = {
  privacy_policy: 'Privacy Policy',
  terms_of_service: 'Terms of Service',
};

export function PublicLegalPolicyPage({ policyType }: { policyType: LegalPolicyType }) {
  const query = useGetCurrentLegalPolicies();
  const policy = query.data?.items.find((item) => item.policyType === policyType);
  return <main className="public-content-page">
    <header className="public-content-header">
      <Link href="/" className="public-content-brand">greenpay<span>.</span></Link>
      <nav aria-label="Legal documents"><Link href="/privacy">Privacy Policy</Link><Link href="/terms">Terms of Service</Link></nav>
    </header>
    <div className="public-content-main">
      <div className="public-eyebrow">GREENPAY / LEGAL</div>
      {query.isLoading ? <p>Loading document…</p> : query.isError ? <div className="content-policy-message"><p>We could not load this document.</p><Btn variant="secondary" onClick={() => { void query.refetch(); }}>Try again</Btn></div> :
        policy?.published && policy.title && policy.content ? <>
          <h1>{policy.title}</h1>
          <div className="public-updated">Published {policy.publishedAt ? new Date(policy.publishedAt).toLocaleDateString() : '—'} · Version {policy.version}</div>
          <article className="public-policy-copy">{policy.content.split(/\n{2,}/).map((paragraph, index) =>
            <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph}</p>)}</article>
        </> : <div className="content-policy-message"><h1>{policyLabels[policyType]}</h1><p>This document has not been published yet.</p></div>}
      <div className="public-content-links"><Link href="/privacy">Privacy Policy</Link><Link href="/terms">Terms of Service</Link><Link href="/sign-in">Sign in</Link></div>
    </div>
    <footer className="public-content-footer">Greenpay · Payments with clarity</footer>
  </main>;
}

export function LegalAcceptanceGate({ children }: { children: ReactNode }) {
  const access = useAccess();
  const query = useGetMerchantLegalConsent();
  const accept = useAcceptMerchantLegalPolicies();
  const invalidate = useInvalidateAll();
  const [checked, setChecked] = useState(false);

  if (access.isLoading || query.isLoading || query.isFetching) return <div className="auth-loading"><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  if (access.isError) return <div className="legal-gate"><h1>Account access could not be checked</h1><p>Reload to continue safely.</p><Btn variant="secondary" onClick={() => { void access.refetch(); }}>Retry</Btn></div>;
  if (access.isAdmin && (query.isError || !query.data?.ready)) return <>{children}</>;
  if (query.isError || !query.data) return <div className="legal-gate"><h1>Policies could not be checked</h1><p>Workspace access is paused until we can confirm the current legal documents.</p><Btn variant="secondary" onClick={() => { void query.refetch(); }}>Retry</Btn></div>;
  if (!query.data.ready) return <div className="legal-gate"><h1>Legal documents are not published yet</h1><p>Workspace access will be available after Greenpay publishes its Privacy Policy and Terms of Service.</p></div>;
  if (query.data.accepted) return <>{children}</>;

  const policies = query.data.policies.filter((policy) => policy.published);
  return <section className="legal-gate" aria-labelledby="legal-gate-title">
    <div className="legal-gate-card">
      <div className="public-eyebrow">GREENPAY / WORKSPACE ACCESS</div>
      <h1 id="legal-gate-title">Review and accept the current policies</h1>
      <p>Accept both current documents before entering your workspace. If a policy is updated, Greenpay will ask you to accept its new version.</p>
      <ul className="legal-document-list">{policies.map((policy) => <li key={policy.policyType}>
        <Link href={policy.policyType === 'privacy_policy' ? '/privacy' : '/terms'}>{policyLabels[policy.policyType]}</Link>
        <span>Version {policy.version}</span>
      </li>)}</ul>
      <label className="legal-consent-check"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>I have reviewed and agree to the current Privacy Policy and Terms of Service.</span></label>
      <Btn disabled={!checked || accept.isPending} onClick={() => accept.mutate({ data: { acceptances: policies.map((policy) => ({ policyType: policy.policyType, version: policy.version })) } }, {
        onSuccess: () => { void invalidate(); },
      })}>{accept.isPending ? 'Saving acceptance…' : 'Accept and continue'}</Btn>
      <Err error={accept.error} />
    </div>
  </section>;
}

export function AdminLegalPoliciesPage() {
  const query = useListAdminLegalPolicies();
  const items = query.data?.items ?? [];
  const [selected, setSelected] = useState<LegalPolicyType>('privacy_policy');
  const selectedPolicy = items.find((item) => item.policyType === selected);
  return <>
    <Heading eyebrow="ADMIN / GOVERNANCE" title="Privacy & terms" subtitle="Edit drafts without changing the live documents. Publishing creates an immutable version and renews user acceptance." />
    <div className="content-policy-tabs" role="tablist" aria-label="Choose a policy">
      {(['privacy_policy', 'terms_of_service'] as const).map((type) => <button key={type} role="tab" aria-selected={selected === type} className={selected === type ? 'content-policy-tab active' : 'content-policy-tab'} onClick={() => setSelected(type)}>{policyLabels[type]}</button>)}
    </div>
    <Async q={query} empty={!items.length} emptyTitle="No policies available" emptyBody="The editable policy records could not be loaded.">
      {selectedPolicy && <PolicyEditor key={selectedPolicy.policyType} policy={selectedPolicy} />}
    </Async>
  </>;
}

function PolicyEditor({ policy }: { policy: LegalPolicyAdmin }) {
  const [title, setTitle] = useState(policy.draftTitle);
  const [content, setContent] = useState(policy.draftContent);
  const client = useQueryClient();
  const save = useSaveAdminLegalPolicyDraft();
  const publish = usePublishAdminLegalPolicy();
  const versions = useListAdminLegalPolicyVersions(policy.policyType);

  useEffect(() => {
    setTitle(policy.draftTitle);
    setContent(policy.draftContent);
  }, [policy.draftTitle, policy.draftContent]);

  function saveDraft() {
    save.mutate({ type: policy.policyType, data: { title, content } }, {
      onSuccess: () => { void client.invalidateQueries(); },
    });
  }
  function publishDraft() {
    if (!window.confirm(`Publish this ${policyLabels[policy.policyType]} as a new version?`)) return;
    publish.mutate({ type: policy.policyType }, {
      onSuccess: () => { void client.invalidateQueries(); },
    });
  }
  const draftDirty = title.trim() !== policy.draftTitle || content.trim() !== policy.draftContent;

  return <div className="content-policy-editor">
    <section className="panel content-edit-panel">
      <div className="panel-head"><div><h2>{policyLabels[policy.policyType]}</h2><p>{policy.publishedVersion ? `Live version ${policy.publishedVersion}` : 'Not published'}</p></div><span className={`content-policy-status ${policy.publishedVersion ? 'published' : ''}`}>{policy.publishedVersion ? 'LIVE' : 'DRAFT ONLY'}</span></div>
      <div className="content-policy-form">
        <Note>The published document stays live while you edit this draft. Enter approved legal wording; Greenpay does not supply policy copy.</Note>
        <Field label="Document title"><input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="Draft text"><textarea value={content} rows={16} maxLength={50000} onChange={(event) => setContent(event.target.value)} placeholder="Paste approved policy wording here." /></Field>
        <div className="content-editor-footer"><span>Draft last saved {new Date(policy.draftUpdatedAt).toLocaleString()}</span><div className="row-actions">
          <Btn variant="secondary" disabled={save.isPending || !title.trim() || !content.trim() || !draftDirty} onClick={saveDraft}>{save.isPending ? 'Saving…' : 'Save draft'}</Btn>
          <Btn disabled={publish.isPending || draftDirty || !policy.draftContent.trim() || !policy.draftTitle.trim()} onClick={publishDraft}>{publish.isPending ? 'Publishing…' : 'Publish new version'}</Btn>
        </div></div>
        <Err error={save.error} /><Err error={publish.error} />
      </div>
    </section>
    <section className="panel content-policy-live">
      <div className="panel-head"><div><h2>Currently published</h2><p>{policy.publishedVersion ? `Version ${policy.publishedVersion}` : 'No live version'}</p></div></div>
      {policy.publishedContent ? <div className="content-policy-live-copy"><strong>{policy.publishedTitle}</strong><p>{policy.publishedContent}</p></div> : <p className="content-policy-empty">No policy text is live. The workspace remains blocked for non-admin users.</p>}
    </section>
    <section className="panel content-policy-history">
      <div className="panel-head"><div><h2>Published versions</h2><p>Previous versions remain available for audit and reference.</p></div></div>
      <Async q={versions} empty={!versions.data?.items.length} emptyTitle="No published versions" emptyBody="A version appears here after the first publication.">
        <div className="content-policy-version-list">{versions.data?.items.map((version) => <details key={version.id} className="content-policy-version">
          <summary><strong>Version {version.version} · {version.title}</strong><span>{new Date(version.publishedAt).toLocaleString()}</span></summary>
          <p>{version.content}</p>
        </details>)}</div>
      </Async>
    </section>
  </div>;
}