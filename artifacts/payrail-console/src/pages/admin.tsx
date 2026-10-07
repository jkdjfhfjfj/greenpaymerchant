import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Search, LoaderCircle, Pencil, Trash2, Plus, ShieldCheck, Eye } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute } from 'wouter';
import {
  useGetAdminSummary, useListAdminMerchants, useGetAdminMerchantDetails, getGetAdminMerchantDetailsQueryKey, useUpdateAdminMerchant, useGetAdminPlatformSettings, useUpdateAdminPlatformSettings,
  useListAdminAuditLog, useListAdminFeeSchedules, useUpdateAdminFeeSchedule, useListAdminFxRates, useCreateAdminFxRate, useUpdateAdminFxRate,
  useListAdminProviderCredentials, useSaveAdminProviderCredentials, useDeleteAdminProviderCredentials,
  useGetAdminCloudinaryUploadStatus, useCreateAdminCloudinaryUploadSignature,
  useGetAdminStatumAccount, getGetAdminStatumAccountQueryKey,
  useFindAdminPlatformUsers, useGrantPlatformAdmin, useRevokePlatformAdmin, getFindAdminPlatformUsersQueryKey, getGetAccessProfileQueryKey,
  useReviewAdminMerchantApplication, getListAdminMerchantsQueryKey,
  useListAdminMerchantApplicationAttachments,
  useCreateAdminMerchantApplicationRequestAttachmentUploadIntent,
  useDeleteAdminMerchantApplicationRequestAttachmentUploadIntent,
  useCreateAdminMerchantVerificationRequest,
  useListAdminCollectionCurrencyAvailability, useUpdateAdminCollectionCurrencyAvailability,
  getListAdminCollectionCurrencyAvailabilityQueryKey, useListSupportedCurrencies,
  type AdminMerchant, type AdminFxRate, type AdminFeeSchedule, type ProviderCredential, type ListAdminMerchantsParams, type PlatformSettings,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CopyBtn, CURRENCIES, Confirm, Err, Field, Gate, Heading, Modal, Note, Pager, Pill, Switch, fmtDate, money, nice, useInvalidateAll } from '@/components/kit';
import { CloudinaryImageUpload } from '@/components/cloudinary-image-upload';

const G = ({ children }: { children: React.ReactNode }) => <Gate need="admin">{children}</Gate>;

export function AdminSummaryPage() { return <G><SummaryInner /></G>; }
function SummaryInner() {
  const q = useGetAdminSummary();
  const d = q.data;
  const tiles: [string, number | undefined, string][] = d ? [['Merchants', d.totalMerchants, 'mint'], ['Active', d.activeMerchants, 'cream'], ['Pending KYC', d.pendingKyc, 'peach'], ['Suspended', d.suspendedMerchants, 'peach'], ['Active API keys', d.activeApiKeys, 'blue'], ['Credential providers', d.credentialProviders, 'blue'], ['Transactions', d.totalTransactions, 'mint']] : [];
  return <><Heading eyebrow="ADMIN" title="Platform summary" subtitle="Merchants, verification, access and provider configuration at a glance." />
    <Async q={q}><div className="metric-grid">{tiles.map(([t, v, tone]) => <section key={t} className={`metric-card tone-${tone}`}><div className="metric-top"><span>{t}</span></div><div className="metric-value" data-testid={`metric-${t.toLowerCase().replaceAll(' ', '-')}`}>{(v ?? 0).toLocaleString()}</div></section>)}</div></Async></>;
}

export function AdminPlatformAdminsPage() { return <G><PlatformAdminsInner /></G>; }
function PlatformAdminsInner() {
  const [email, setEmail] = useState('');
  const [searchEmail, setSearchEmail] = useState('');
  const [selected, setSelected] = useState<{ userId: string; email: string; promote: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const q = useFindAdminPlatformUsers({ email: searchEmail }, {
    query: { queryKey: getFindAdminPlatformUsersQueryKey({ email: searchEmail }), enabled: Boolean(searchEmail) },
  });
  const grant = useGrantPlatformAdmin();
  const revoke = useRevokePlatformAdmin();
  const queryClient = useQueryClient();
  const pending = grant.isPending || revoke.isPending;
  const mutationError = grant.error || revoke.error;

  function findUsers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchEmail(email.trim().toLowerCase());
  }

  async function completeMutation() {
    setSelected(null);
    setReason('');
    grant.reset();
    revoke.reset();
    await Promise.all([
      q.refetch(),
      queryClient.invalidateQueries({ queryKey: getGetAccessProfileQueryKey() }),
    ]);
  }

  function confirmRoleChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !reason.trim()) return;
    const data = { reason: reason.trim() };
    const onSuccess = () => { void completeMutation(); };
    if (selected.promote) grant.mutate({ userId: selected.userId, data }, { onSuccess });
    else revoke.mutate({ userId: selected.userId, data }, { onSuccess });
  }

  const users = q.data?.items ?? [];
  return <>
    <Heading eyebrow="ADMIN / ACCESS" title="Platform administrators" subtitle="Find users by exact verified primary email. Role decisions are persisted and recorded with your reason." />
    <Card title="Find a verified Clerk user" subtitle="Email is only a lookup term. The server verifies the Clerk user's primary address before any role change.">
      <form className="toolbar" onSubmit={findUsers}>
        <div className="search-box"><Search size={14} /><input type="email" required maxLength={254} placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} data-testid="input-admin-user-email" /></div>
        <Btn type="submit" disabled={q.isFetching} testId="button-find-admin-user">{q.isFetching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}Find user</Btn>
      </form>
    </Card>
    {searchEmail && <Async q={q} empty={!users.length} emptyTitle="No verified primary email match" emptyBody="Check the address and try again. Only users with that exact verified primary Clerk email are returned.">
      <div className="table-wrap"><table className="dt"><thead><tr><th>User</th><th>Effective role</th><th>Persistent assignment</th><th>Bootstrap</th><th /></tr></thead><tbody>
        {users.map((user) => <tr key={user.userId} data-testid={`row-platform-admin-${user.userId}`}>
          <td><strong>{user.email}</strong><span className="sub mono">{user.userId}</span></td>
          <td><Pill value={user.effectiveRole} /></td>
          <td>{user.assignmentActive ? `Assigned ${fmtDate(user.assignedAt)}` : user.revokedAt ? `Revoked ${fmtDate(user.revokedAt)}` : 'Not assigned'}</td>
          <td>{user.bootstrapAdmin ? <Pill value="non_revocable" /> : '—'}</td>
          <td>{user.bootstrapAdmin
            ? <span className="sub">Managed by ADMIN_EMAILS</span>
            : <Btn variant={user.assignmentActive ? 'danger' : 'secondary'} small disabled={pending} onClick={() => { grant.reset(); revoke.reset(); setReason(''); setSelected({ userId: user.userId, email: user.email, promote: !user.assignmentActive }); }}>
              {user.assignmentActive ? <><ShieldCheck size={13} />Demote</> : <><Plus size={13} />Promote</>}
            </Btn>}</td>
        </tr>)}
      </tbody></table></div>
    </Async>}
    {selected && <Modal
      title={selected.promote ? 'Promote platform administrator' : 'Demote platform administrator'}
      description={`${selected.promote ? 'Grant' : 'Revoke'} platform-admin access for ${selected.email}. This change takes effect immediately and is recorded in the audit log.`}
      onClose={() => { if (!pending) setSelected(null); }}>
      <form className="form-stack" onSubmit={confirmRoleChange}>
        <Note tone="warn">{selected.promote
          ? 'Confirm only if this person should manage Greenpay platform-wide settings and customer operations.'
          : 'Confirm only if another effective administrator can retain access. The last effective administrator cannot be removed.'}</Note>
        <Field label="Required audit reason"><textarea required minLength={1} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this access change is necessary" data-testid="input-admin-role-reason" /></Field>
        <Err error={mutationError} />
        <div className="row-actions"><Btn variant="secondary" disabled={pending} onClick={() => setSelected(null)}>Cancel</Btn>
          <Btn type="submit" variant={selected.promote ? 'primary' : 'danger'} disabled={pending || !reason.trim()} testId="button-confirm-admin-role">
            {pending && <LoaderCircle size={14} className="spin" />}{selected.promote ? 'Confirm promotion' : 'Confirm demotion'}
          </Btn></div>
      </form>
    </Modal>}
  </>;
}

export function AdminMerchantsPage() { return <G><MerchantsInner /></G>; }
function MerchantsInner() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [kyc, setKyc] = useState('');
  const params: ListAdminMerchantsParams = { ...(search ? { search } : {}), ...(status ? { status: status as never } : {}), ...(kyc ? { kycStatus: kyc as never } : {}) };
  const q = useListAdminMerchants(params);
  const [edit, setEdit] = useState<AdminMerchant | null>(null);
  const [details, setDetails] = useState<AdminMerchant | null>(null);
  const [review, setReview] = useState<AdminMerchant | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Merchants" subtitle="Review, activate, suspend and annotate merchant accounts." />
    <div className="toolbar"><div className="search-box"><Search size={14} /><input placeholder="Search business name" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-merchant-search" /></div>
      <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="select-merchant-status"><option value="">Any status</option>{['pending', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{nice(s)}</option>)}</select>
      <select value={kyc} onChange={(e) => setKyc(e.target.value)} data-testid="select-merchant-kyc"><option value="">Any verification</option>{['not_started', 'pending', 'in_review', 'approved', 'declined', 'expired', 'reverification_required'].map((s) => <option key={s} value={s}>{nice(s)}</option>)}</select></div>
     <Async q={q} empty={!items.length} emptyTitle="No merchants match" emptyBody="Adjust the search or filters."><div className="table-wrap"><table className="dt"><thead><tr><th>Business</th><th>Country</th><th>Base</th><th>Account</th><th>Application</th><th>Address</th><th>Verification</th><th>Created</th><th /></tr></thead><tbody>
        {items.map((m) => <tr key={m.id} data-testid={`row-merchant-${m.id}`}><td><strong>{m.businessName}</strong><span className="sub">{m.riskNote || m.ownerUserId}</span></td><td>{m.country}</td><td>{m.baseCurrency}</td><td><Pill value={m.status} /></td><td><Pill value={m.applicationStatus} />{m.applicationSubmittedAt && <span className="sub">Submitted {fmtDate(m.applicationSubmittedAt)}</span>}</td><td><Pill value={m.addressVerificationStatus} /></td><td><Pill value={m.kycStatus} /></td><td>{fmtDate(m.createdAt)}</td><td><div className="row-actions">{m.applicationStatus === 'awaiting_review' && m.applicationDetails && <Btn small onClick={() => setReview(m)}><ShieldCheck size={13} />Review</Btn>}<Btn variant="secondary" small onClick={() => setDetails(m)}><Eye size={13} />Details</Btn><a className="btn btn-secondary btn-sm" href={`/admin/merchants/${m.id}/controls`}>Manage status</a><Btn variant="secondary" small onClick={() => setEdit(m)}><Pencil size={13} />Edit</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <MerchantEdit m={edit} onClose={() => setEdit(null)} />}
    {details && <MerchantDetails m={details} onClose={() => setDetails(null)} />}
    {review && <MerchantApplicationReview m={review} onClose={() => setReview(null)} />}</>;
}

function MerchantApplicationReview({ m, onClose }: { m: AdminMerchant; onClose: () => void }) {
  const mutation = useReviewAdminMerchantApplication();
  const attachments = useListAdminMerchantApplicationAttachments(m.id);
  const createUploadIntent = useCreateAdminMerchantApplicationRequestAttachmentUploadIntent();
  const deleteUploadIntent = useDeleteAdminMerchantApplicationRequestAttachmentUploadIntent();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ key: string; token: string }>>([]);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const requestId = useRef(globalThis.crypto.randomUUID());
  const requestSaved = useRef(false);
  const application = m.applicationDetails;
  if (!application) return null;
  const canSubmit = reason.trim().length >= 5 && reason.trim().length <= 2000 &&
    !mutation.isPending && !uploading && !createUploadIntent.isPending;
  const fileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
  function closeReview() {
    if (!requestSaved.current) {
      for (const uploaded of uploadedFiles) {
        void deleteUploadIntent.mutateAsync({ merchantId: m.id, uploadToken: uploaded.token }).catch(() => undefined);
      }
    }
    onClose();
  }
  async function stageFiles(): Promise<string[]> {
    const tokens: string[] = [];
    for (const file of files) {
      const key = fileKey(file);
      const existing = uploadedFiles.find((uploaded) => uploaded.key === key);
      if (existing) {
        tokens.push(existing.token);
        continue;
      }
      const intent = await createUploadIntent.mutateAsync({ merchantId: m.id, data: {
        name: file.name,
        size: file.size,
        contentType: file.type as 'application/pdf' | 'image/png' | 'image/jpeg',
        requestId: requestId.current,
      } });
      const uploadBody = new FormData();
      for (const [key, value] of Object.entries(intent.uploadParameters)) uploadBody.append(key, value);
      uploadBody.append('file', file);
      try {
        const response = await fetch(intent.uploadURL, { method: 'POST', body: uploadBody });
        if (!response.ok) throw new Error(`Private upload failed for ${file.name} (${response.status}).`);
      } catch (error) {
        await deleteUploadIntent.mutateAsync({ merchantId: m.id, uploadToken: intent.uploadToken }).catch(() => undefined);
        throw error;
      }
      setUploadedFiles((current) => [...current, { key, token: intent.uploadToken }]);
      tokens.push(intent.uploadToken);
    }
    return tokens;
  }
  async function decide(decision: 'approve' | 'request_information') {
    setUploadError('');
    setUploading(true);
    try {
      const tokens = decision === 'request_information' ? await stageFiles() : [];
      await mutation.mutateAsync({ merchantId: m.id, data: {
        decision,
        reason: reason.trim(),
        ...(decision === 'request_information' ? { requestId: requestId.current } : {}),
        ...(tokens.length ? { attachmentUploadTokens: tokens } : {}),
      } });
      requestSaved.current = true;
      await queryClient.invalidateQueries({ queryKey: getListAdminMerchantsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetAdminMerchantDetailsQueryKey(m.id) });
      onClose();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not save the application decision.');
    } finally {
      setUploading(false);
    }
  }
  function selectFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length + selected.length > 5) {
      setUploadError('Attach no more than five files to one document request.');
      return;
    }
    if (selected.some((file) => !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
      setUploadError('Choose PDF, PNG, or JPEG files no larger than 10 MB each.');
      return;
    }
    setUploadError('');
    setFiles((current) => [...current, ...selected]);
  }
  function removeFile(file: File) {
    const uploaded = uploadedFiles.find((item) => item.key === fileKey(file));
    if (uploaded) {
      void deleteUploadIntent.mutateAsync({ merchantId: m.id, uploadToken: uploaded.token }).catch((error) => {
        setUploadError(error instanceof Error ? error.message : 'Could not cancel the private upload.');
      });
      setUploadedFiles((current) => current.filter((item) => item.token !== uploaded.token));
    }
    setFiles((current) => current.filter((item) => fileKey(item) !== fileKey(file)));
  }
  return <Modal title={`Review · ${m.businessName}`} description="Review the submitted business details and record a reason for the decision." onClose={() => { if (!mutation.isPending && !uploading) closeReview(); }} wide>
    <div className="form-stack">
      <div className="kv">
        <div><span>Application status</span><Pill value={m.applicationStatus} /></div>
        <div><span>Submitted</span><strong>{fmtDate(m.applicationSubmittedAt)}</strong></div>
        <div><span>Last reviewed</span><strong>{fmtDate(m.applicationReviewedAt)}</strong></div>
      </div>
      <Card title="Business details">
        {m.addressVerificationStatus === 'manual_review' && <Note tone="warn">
          The address was submitted manually. Approving this application also records approval of the address.
          {m.addressVerificationReason ? ` Applicant note: ${m.addressVerificationReason}` : ''}
          {' '}If the applicant supplied address proof, it is listed below under Application documents and media.
        </Note>}
        <div className="application-review-grid">
          <div><span>Business type</span><strong>{application.businessType.replaceAll('_', ' ')}</strong></div>
          <div><span>Country and base currency</span><strong>{m.country} · {m.baseCurrency}</strong></div>
          <div><span>Address verification</span><Pill value={m.addressVerificationStatus} /></div>
          <div><span>Registration number</span><strong>{m.registrationNumber || '—'}</strong></div>
          <div><span>Nature of business</span><p>{application.natureOfBusiness}</p></div>
          <div><span>Registered address</span><p>{application.registeredAddress}</p></div>
          <div><span>Website</span><strong>{application.website || '—'}</strong></div>
        </div>
      </Card>
      <Card title="Expected activity">
        <div className="application-review-grid">
          <div><span>Monthly volume</span><strong>{money(application.expectedMonthlyVolume, application.expectedMonthlyVolumeCurrency)} / month</strong></div>
          <div><span>Monthly transactions</span><strong>{application.expectedMonthlyTransactions.toLocaleString()}</strong></div>
          <div><span>Average transaction value</span><strong>{money(application.expectedAverageTransactionValue, application.expectedMonthlyVolumeCurrency)}</strong></div>
          <div><span>Customer countries</span><strong>{application.expectedCustomerCountries.join(', ')}</strong></div>
          <div><span>Collection currencies</span><strong>{application.expectedCollectionCurrencies.join(', ')}</strong></div>
          <div><span>Source of funds</span><p>{application.sourceOfFunds}</p></div>
        </div>
      </Card>
      <Card title="Application documents and media" subtitle="Private files are available only to authorized reviewers.">
        {attachments.isLoading ? <span className="sub">Loading submitted files…</span> : attachments.isError ? <Note tone="warn">Submitted files could not be loaded. Close and reopen this review to retry.</Note> : attachments.data?.items.length ? <div className="form-stack">
          {attachments.data.items.map((file) => <a key={file.id} className="text-link" data-testid={`link-admin-application-file-${m.id}-${file.id}`} href={file.downloadPath} download>{file.direction === 'requested' ? 'Shared by Greenpay · ' : 'Submitted by merchant · '}{file.name} · {file.contentType} · {(file.size / 1024 / 1024).toFixed(2)} MB</a>)}
        </div> : <span className="sub">No application files have been submitted.</span>}
      </Card>
      {m.applicationRequestedInfo && <Note tone="warn">Previously requested: {m.applicationRequestedInfo}</Note>}
      {m.applicationStatus === 'awaiting_review' ? <Field label="Decision reason" hint="Required · at least 5 characters · visible in the application decision record">
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} maxLength={2000} required placeholder="Record the reason for this decision" data-testid={`input-application-review-reason-${m.id}`} />
      </Field> : <Note tone="warn">This application is not awaiting review. Decision actions are unavailable; refresh the merchant list for its current status.</Note>}
      {m.applicationStatus === 'awaiting_review' && <Field label="Files to share with the merchant" hint="Optional · PDF, PNG, or JPEG · up to five files · 10 MB each · attached only when you request information">
        <input type="file" multiple accept="application/pdf,image/png,image/jpeg" disabled={uploading || mutation.isPending} onChange={selectFiles} data-testid={`input-admin-request-attachment-${m.id}`} />
        {files.length > 0 && <div className="form-stack">{files.map((file, index) => <div key={fileKey(file)} className="setting-row">
          <span data-testid={`text-admin-request-file-${m.id}-${index}`}>{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</span>
          <button type="button" className="btn btn-secondary btn-sm" data-testid={`button-remove-admin-request-file-${m.id}-${index}`} disabled={uploading || mutation.isPending} onClick={() => removeFile(file)}>Remove</button>
        </div>)}</div>}
      </Field>}
      <Err error={mutation.error} />
      {uploadError && <Note tone="warn">{uploadError}</Note>}
      <div className="row-actions application-review-actions">
        <Btn variant="secondary" disabled={mutation.isPending || uploading} onClick={closeReview}>Cancel</Btn>
        {m.applicationStatus === 'awaiting_review' && <>
          <Btn variant="secondary" disabled={!canSubmit} onClick={() => void decide('request_information')} testId={`button-request-information-${m.id}`}>{uploading && <LoaderCircle size={14} className="spin" />}Request information</Btn>
          <Btn disabled={!canSubmit} onClick={() => void decide('approve')} testId={`button-approve-application-${m.id}`}><ShieldCheck size={14} />Approve application</Btn>
        </>}
      </div>
    </div>
  </Modal>;
}
function MerchantEdit({ m, onClose }: { m: AdminMerchant; onClose: () => void }) {
  const up = useUpdateAdminMerchant();
  const inv = useInvalidateAll();
  const [flags, setFlags] = useState({ paymentsEnabled: m.paymentsEnabled ?? true, payoutsEnabled: m.payoutsEnabled ?? true, refundsEnabled: m.refundsEnabled ?? true, apiAccessEnabled: m.apiAccessEnabled ?? true });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const risk = String(f.get('risk') || '').trim();
    up.mutate({ id: m.id, data: { businessName: String(f.get('name')).trim(), baseCurrency: String(f.get('cur')), riskNote: risk || null, paymentsEnabled: flags.paymentsEnabled, payoutsEnabled: flags.payoutsEnabled, refundsEnabled: flags.refundsEnabled, apiAccessEnabled: flags.apiAccessEnabled } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title={`Edit ${m.businessName}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="Business name"><input name="name" defaultValue={m.businessName} required minLength={2} maxLength={150} data-testid="input-edit-name" /></Field>
    <Field label="Base currency"><select name="cur" defaultValue={m.baseCurrency}>{[...new Set([m.baseCurrency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}</select></Field>
    <Note tone="warn">Account suspension and reactivation require an audit reason in the merchant controls page.</Note>
    <Field label="Risk notes" hint="Internal only, 1000 characters"><textarea name="risk" defaultValue={m.riskNote ?? ''} maxLength={1000} data-testid="input-edit-risk" /></Field>
    <Field label="Capabilities">{([['paymentsEnabled', 'Payments'], ['payoutsEnabled', 'Payouts'], ['refundsEnabled', 'Refunds'], ['apiAccessEnabled', 'API access']] as const).map(([k, t]) => <div className="setting-row" key={k} style={{ padding: '7px 0' }}><span>{t}</span><Switch on={flags[k]} label={`merchant ${t}`} onChange={(v) => setFlags({ ...flags, [k]: v })} /></div>)}</Field>
    <Err error={up.error} /><Btn type="submit" disabled={up.isPending} testId="button-save-merchant">{up.isPending && <LoaderCircle size={14} className="spin" />}Save changes</Btn></form></Modal>;
}

function MerchantDetails({ m, onClose }: { m: AdminMerchant; onClose: () => void }) {
  const q = useGetAdminMerchantDetails(m.id, {
    query: { queryKey: ['admin-merchant-details', m.id], refetchOnMount: 'always', staleTime: 30_000 },
  });
  const queryClient = useQueryClient();
  const verificationRequest = useCreateAdminMerchantVerificationRequest();
  const [verificationReason, setVerificationReason] = useState('');
  const merchant = q.data?.merchant;
  const owner = q.data?.owner;
  const verifiedEmails = owner?.verifiedEmails.join(' · ') || '—';
  const verifiedPhones = owner?.verifiedPhones.join(' · ') || '—';
  const ownerName = [owner?.firstName, owner?.lastName].filter(Boolean).join(' ') || 'Name not provided';
  const verificationReasonValid = verificationReason.trim().length >= 5 && verificationReason.trim().length <= 2000;
  function requestReverification(kind: 'kyc' | 'kyb') {
    verificationRequest.mutate({ merchantId: m.id, data: { kind, reason: verificationReason.trim() } }, {
      onSuccess: async () => {
        setVerificationReason('');
        await q.refetch();
        await queryClient.invalidateQueries({ queryKey: getListAdminMerchantsQueryKey() });
      },
    });
  }
  return <Modal title={`Merchant details — ${merchant?.businessName ?? m.businessName}`} onClose={onClose}>
    <Async q={q}>
      {merchant && owner && <div className="form-stack">
        {owner.lookupStatus === 'not_found' && <Note tone="warn">The merchant record is available, but the owner account was not found in Clerk.</Note>}
        <Card title="Business profile">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <div><span className="sub">Legal business name</span><strong>{merchant.businessName}</strong></div>
            <div><span className="sub">Public shop name</span><strong>{merchant.shopName || '—'}</strong></div>
            <div><span className="sub">Country</span><strong>{merchant.country}</strong></div>
            <div><span className="sub">Base currency</span><strong>{merchant.baseCurrency}</strong></div>
            <div><span className="sub">Registration number</span><strong>{merchant.registrationNumber || '—'}</strong></div>
            {merchant.shopLogoUrl && <div><span className="sub">Shop logo</span><a href={merchant.shopLogoUrl} target="_blank" rel="noreferrer">Open image</a></div>}
          </div>
        </Card>
        <Card title="Business application" subtitle="Submitted business activity and source-of-funds information, with the current decision timeline.">
          {merchant.applicationDetails ? <div className="form-stack">
            <div className="application-review-grid">
              <div><span>Application status</span><Pill value={merchant.applicationStatus} /></div>
              <div><span>Address verification</span><Pill value={merchant.addressVerificationStatus} /></div>
              <div><span>Submitted</span><strong>{fmtDate(merchant.applicationSubmittedAt)}</strong></div>
              <div><span>Reviewed</span><strong>{fmtDate(merchant.applicationReviewedAt)}</strong></div>
              <div><span>Business type</span><strong>{merchant.applicationDetails.businessType.replaceAll('_', ' ')}</strong></div>
              <div><span>Nature of business</span><p>{merchant.applicationDetails.natureOfBusiness}</p></div>
              <div><span>Registered address</span><p>{merchant.applicationDetails.registeredAddress}</p></div>
              {merchant.addressVerificationReason && <div><span>Address review note</span><p>{merchant.addressVerificationReason}</p></div>}
              <div><span>Website</span><strong>{merchant.applicationDetails.website || '—'}</strong></div>
              <div><span>Expected monthly volume</span><strong>{money(merchant.applicationDetails.expectedMonthlyVolume, merchant.applicationDetails.expectedMonthlyVolumeCurrency)} / month</strong></div>
              <div><span>Expected monthly transactions</span><strong>{merchant.applicationDetails.expectedMonthlyTransactions.toLocaleString()}</strong></div>
              <div><span>Average transaction value</span><strong>{money(merchant.applicationDetails.expectedAverageTransactionValue, merchant.applicationDetails.expectedMonthlyVolumeCurrency)}</strong></div>
              <div><span>Customer countries</span><strong>{merchant.applicationDetails.expectedCustomerCountries.join(', ')}</strong></div>
              <div><span>Collection currencies</span><strong>{merchant.applicationDetails.expectedCollectionCurrencies.join(', ')}</strong></div>
              <div><span>Source of funds</span><p>{merchant.applicationDetails.sourceOfFunds}</p></div>
              <div><span>Information requested</span><p>{merchant.applicationRequestedInfo || '—'}</p></div>
            </div>
          </div> : <div className="empty-state"><strong>No business application details</strong><span>The merchant has not submitted an application.</span></div>}
        </Card>
        <Card title="Owner contact">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <div><span className="sub">Name</span><strong>{ownerName}</strong></div>
            <div><span className="sub">Primary verified email</span><strong>{owner.primaryEmail || '—'}</strong></div>
            <div><span className="sub">All verified email addresses</span><strong>{verifiedEmails}</strong></div>
            <div><span className="sub">Primary verified phone</span><strong>{owner.primaryPhone || '—'}</strong></div>
            <div><span className="sub">All verified phone numbers</span><strong>{verifiedPhones}</strong></div>
            <div><span className="sub">Clerk user ID</span><strong className="mono">{owner.userId}</strong></div>
            <div><span className="sub">Account created</span><strong>{fmtDate(owner.createdAt)}</strong></div>
            <div><span className="sub">Last sign-in</span><strong>{fmtDate(owner.lastSignInAt)}</strong></div>
          </div>
        </Card>
        <Card title="Account and verification">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <div><span className="sub">Account status</span><Pill value={merchant.status} /></div>
            <div><span className="sub">KYC</span><Pill value={merchant.kycStatus} /></div>
            <div><span className="sub">KYB</span><Pill value={merchant.kybStatus} /></div>
            <div><span className="sub">Registered</span><strong>{fmtDate(merchant.createdAt)}</strong></div>
            <div><span className="sub">Last updated</span><strong>{fmtDate(merchant.updatedAt)}</strong></div>
            <div><span className="sub">KYC updated</span><strong>{fmtDate(merchant.verificationUpdatedAt)}</strong></div>
            <div><span className="sub">KYB updated</span><strong>{fmtDate(merchant.kybVerificationUpdatedAt)}</strong></div>
            <div><span className="sub">KYC session ID</span><strong className="mono">{merchant.diditSessionId || '—'}</strong></div>
            <div><span className="sub">KYB session ID</span><strong className="mono">{merchant.diditKybSessionId || '—'}</strong></div>
          </div>
          {(merchant.kycRequestedInfo || merchant.kybRequestedInfo) && <div className="form-stack" style={{ marginTop: 12 }}>
            {merchant.kycRequestedInfo && <Note tone="warn">KYC reverification requested: {merchant.kycRequestedInfo}</Note>}
            {merchant.kybRequestedInfo && <Note tone="warn">KYB reverification requested: {merchant.kybRequestedInfo}</Note>}
          </div>}
          <div className="form-stack" style={{ marginTop: 14 }}>
            <Field label="Reason for reverification" hint="Required · visible to the merchant and included in their alert">
              <textarea data-testid={`input-verification-request-reason-${m.id}`} value={verificationReason} onChange={(event) => setVerificationReason(event.target.value)} minLength={5} maxLength={2000} placeholder="Explain what the merchant needs to verify again" />
            </Field>
            <Err error={verificationRequest.error} />
            <div className="row-actions">
              <Btn variant="secondary" disabled={!verificationReasonValid || verificationRequest.isPending} onClick={() => requestReverification('kyc')} testId={`button-request-kyc-reverification-${m.id}`}>Request KYC reverification</Btn>
              <Btn variant="secondary" disabled={!verificationReasonValid || verificationRequest.isPending} onClick={() => requestReverification('kyb')} testId={`button-request-kyb-reverification-${m.id}`}>Request KYB reverification</Btn>
            </div>
          </div>
        </Card>
        <Card title="Platform capabilities and internal notes">
          <div className="form-stack">
            <div className="setting-row"><span>Payments</span><Pill value={merchant.paymentsEnabled ? 'enabled' : 'disabled'} /></div>
            <div className="setting-row"><span>Payouts</span><Pill value={merchant.payoutsEnabled ? 'enabled' : 'disabled'} /></div>
            <div className="setting-row"><span>Refunds</span><Pill value={merchant.refundsEnabled ? 'enabled' : 'disabled'} /></div>
            <div className="setting-row"><span>API access</span><Pill value={merchant.apiAccessEnabled ? 'enabled' : 'disabled'} /></div>
            <div><span className="sub">Risk notes</span><p>{merchant.riskNote || 'No internal notes.'}</p></div>
            <a className="btn btn-secondary btn-sm" href={`/admin/merchants/${merchant.id}/controls`}>Open merchant controls</a>
          </div>
        </Card>
      </div>}
    </Async>
  </Modal>;
}

type MerchantActionKey =
  | 'collect' | 'createLinks' | 'refundRequests' | 'disputeRequests' | 'invoices'
  | 'reminders' | 'payoutRequests' | 'destinationChanges' | 'walletConversion'
  | 'teamManagement' | 'apiAccess';
type MerchantControlsResponse = {
  merchantId: number;
  businessName: string;
  status: string;
  controls: Record<MerchantActionKey, boolean>;
  payoutSafety: {
    largePayoutThresholds: Record<string, number>;
    dualApprovalEnabled: boolean;
    destinationChangeRequiresDualApproval: true;
  };
  usage: Array<{ action: string; currency: string; confirmedAmount: number; basis: string }>;
  limits: Array<Record<string, string | number | null>>;
  updatedAt: string;
};
const ACTION_CONTROLS: Array<[MerchantActionKey, string, string]> = [
  ['collect', 'Collect payments', 'Start a new collection or payment checkout.'],
  ['createLinks', 'Create payment links', 'Create new shareable payment links.'],
  ['refundRequests', 'Submit refund requests', 'Request review of a customer refund.'],
  ['disputeRequests', 'Submit dispute requests', 'Open a dispute or payment case.'],
  ['invoices', 'Create invoices', 'Create and send invoices; historical invoices remain readable.'],
  ['reminders', 'Send reminders', 'Create invoice or payment reminders.'],
  ['payoutRequests', 'Request payouts', 'Request a payout from eligible funds.'],
  ['destinationChanges', 'Change payout destinations', 'Edit payout destination details; destination changes always require a second approval.'],
  ['walletConversion', 'Convert wallet funds', 'Request conversion between supported wallet currencies.'],
  ['teamManagement', 'Manage team', 'Invite, change roles, or remove workspace users.'],
  ['apiAccess', 'Manage API access', 'Create or use merchant API access.'],
];

async function requestMerchantControls<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, {
    credentials: 'include',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `The request failed with status ${response.status}.`;
    throw new Error(error);
  }
  return payload as T;
}

export function AdminMerchantControlsPage() {
  return <G><AdminMerchantControlsInner /></G>;
}

function AdminMerchantControlsInner() {
  const [, params] = useRoute('/admin/merchants/:merchantId/controls');
  const merchantId = Number(params?.merchantId);
  const validId = Number.isSafeInteger(merchantId) && merchantId > 0;
  const queryKey = ['admin-merchant-controls', merchantId];
  const q = useQuery({
    queryKey,
    queryFn: () => requestMerchantControls<MerchantControlsResponse>(`/admin/merchants/${merchantId}/controls`),
    enabled: validId,
    refetchInterval: 12000,
  });
  const inv = useInvalidateAll();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => requestMerchantControls<MerchantControlsResponse>(
      `/admin/merchants/${merchantId}/controls`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
    onSuccess: async () => {
      await q.refetch();
      void inv();
      setDirty(false);
      setChangedActions(new Set());
      setReason('');
    },
  });
  const updateStatus = useMutation({
    mutationFn: (body: { status: 'pending' | 'active' | 'suspended'; reason: string }) =>
      requestMerchantControls(`/admin/merchants/${merchantId}/status`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void q.refetch();
      void inv();
      setReason('');
    },
  });
  const [controls, setControls] = useState<Record<MerchantActionKey, boolean> | null>(null);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [dualApproval, setDualApproval] = useState(true);
  const [reason, setReason] = useState('');
  const [nextStatus, setNextStatus] = useState<'pending' | 'active' | 'suspended'>('pending');
  const [dirty, setDirty] = useState(false);
  const [changedActions, setChangedActions] = useState<Set<MerchantActionKey>>(new Set());
  const [newCurrency, setNewCurrency] = useState<string>(CURRENCIES[0] ?? 'USD');
  useEffect(() => {
    if (!q.data || dirty) return;
    setControls({ ...q.data.controls });
    setThresholds(Object.fromEntries(Object.entries(q.data.payoutSafety.largePayoutThresholds).map(([currency, amount]) => [currency, String(amount)])));
    setDualApproval(q.data.payoutSafety.dualApprovalEnabled);
  }, [q.data, dirty]);
  useEffect(() => {
    if (q.data && ['pending', 'active', 'suspended'].includes(q.data.status)) {
      setNextStatus(q.data.status as 'pending' | 'active' | 'suspended');
    }
  }, [q.data?.status]);

  if (!validId) return <><Heading eyebrow="ADMIN / MERCHANT" title="Merchant controls" /><Note tone="danger">A valid merchant ID is required to load controls.</Note></>;
  const hasReason = reason.trim().length > 0 && reason.trim().length <= 1000;
  const thresholdEntries = Object.entries(thresholds).filter(([, value]) => value.trim() !== '');
  const thresholdsValid = thresholdEntries.every(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
  const canSave = hasReason && thresholdsValid && Boolean(controls) && !save.isPending;
  const title = q.data ? q.data.businessName : `Merchant #${merchantId}`;
  return <>
    <Heading eyebrow="ADMIN / MERCHANT CONTROLS" title={title} subtitle="Reversible capability controls, safety policy, current limits, and committed usage." />
    <Async q={q}>
      {q.data && controls && <div className="form-stack">
        <Card title="Account status" subtitle="Suspending blocks new actions; historical merchant records remain readable. Every status change requires a reason.">
          <div className="setting-row"><div><strong>Current status</strong><span>Last updated {fmtDate(q.data.updatedAt)}</span></div><Pill value={q.data.status} /></div>
          <Field label="Set account status">
            <select value={nextStatus} disabled={q.data.status === 'closed' || updateStatus.isPending} onChange={(event) => setNextStatus(event.target.value as 'pending' | 'active' | 'suspended')}>
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </Field>
          <Field label="Audit reason"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="Explain why this account is being changed" /></Field>
          <div className="row-actions">
            <Btn variant={nextStatus === 'suspended' ? 'danger' : 'primary'} disabled={!hasReason || updateStatus.isPending || q.data.status === 'closed' || nextStatus === q.data.status} onClick={() => updateStatus.mutate({ status: nextStatus, reason: reason.trim() })}>Save account status</Btn>
          </div>
          {q.data.status === 'closed' && <Note tone="warn">Closed accounts cannot be changed from this page.</Note>}
          <Err error={updateStatus.error} />
        </Card>
        <Card title="Merchant actions" subtitle="Disabled actions are explicitly reported to merchant clients. Reads of prior transactions, invoices and cases remain available.">
          <div className="form-stack">
            {ACTION_CONTROLS.map(([key, label, detail]) => <div className="setting-row" key={key}>
              <div><strong>{label}</strong><span>{detail}</span></div>
              <Switch on={controls[key]} label={`merchant ${label}`} onChange={(enabled) => {
                setControls((current) => current ? { ...current, [key]: enabled } : current);
                setChangedActions((current) => new Set(current).add(key));
                setDirty(true);
              }} />
            </div>)}
          </div>
          <Note tone="warn">These switches cannot override the merchant's existing payments, payouts, refunds, or API flags, account status, verification requirements, transaction limits, balance checks, or provider confirmation rules.</Note>
        </Card>
        <Card title="Payout safety" subtitle="Thresholds are explicit per currency. A currency with no threshold is held for manual review; no threshold is guessed.">
          <div className="setting-row">
            <div><strong>Additional dual approval</strong><span>Require a second approval under the merchant's payout policy.</span></div>
            <Switch on={dualApproval} label="additional payout dual approval" onChange={(enabled) => { setDualApproval(enabled); setDirty(true); }} />
          </div>
          <div className="setting-row"><div><strong>Changed payout destination</strong><span>Dual approval is mandatory and cannot be disabled by an administrator.</span></div><Pill value="required" /></div>
          <div className="form-grid" style={{ alignItems: 'end' }}>
            <Field label="Currency"><select value={newCurrency} onChange={(event) => setNewCurrency(event.target.value)}>{CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}</select></Field>
            <Btn variant="secondary" onClick={() => { setThresholds((current) => ({ ...current, [newCurrency]: current[newCurrency] ?? '' })); setDirty(true); }}>Add currency threshold</Btn>
          </div>
          {!Object.keys(thresholds).length && <Note tone="warn">No explicit thresholds are set. Payouts will be held for manual review in every currency.</Note>}
          <div className="form-stack">{Object.entries(thresholds).map(([currency, amount]) => <div className="form-grid" key={currency}>
            <Field label={`${currency} large-payout threshold`} hint="Positive amount; a payout at or above this threshold requires additional review"><input type="number" min="0.01" step="any" value={amount} onChange={(event) => { setThresholds((current) => ({ ...current, [currency]: event.target.value })); setDirty(true); }} /></Field>
            <Btn variant="quiet" onClick={() => { const next = { ...thresholds }; delete next[currency]; setThresholds(next); setDirty(true); }}>Remove</Btn>
          </div>)}</div>
          {!thresholdsValid && <Note tone="danger">Each configured threshold must be a positive finite amount.</Note>}
        </Card>
        <div className="form-grid">
          <Card title="Committed usage" subtitle="Only committed usage is shown as confirmed; pending and uncertain activity is excluded.">
            {!q.data.usage.length ? <p className="sub">No committed usage recorded.</p> : <div className="table-wrap"><table className="dt"><thead><tr><th>Action</th><th>Currency</th><th className="num">Confirmed amount</th></tr></thead><tbody>
              {q.data.usage.map((row) => <tr key={`${row.action}:${row.currency}`}><td>{nice(row.action)}</td><td>{row.currency}</td><td className="num">{money(row.confirmedAmount, row.currency)}</td></tr>)}
            </tbody></table></div>}
          </Card>
          <Card title="Verification limits" subtitle="Configured tier limits remain independently enforced.">
            {!q.data.limits.length ? <p className="sub">No limits are configured for this merchant's current verification tier.</p> : <div className="table-wrap"><table className="dt"><thead><tr><th>Tier / currency</th><th>Collection / day / month</th><th>Payout</th><th>Conversion</th></tr></thead><tbody>
              {q.data.limits.map((row, index) => <tr key={`${row.tier}:${row.currency}:${index}`}><td>{nice(String(row.tier))} · {row.currency}</td><td>{row.collectionPerTransactionLimit ?? '—'} / {row.collectionDailyLimit ?? '—'} / {row.collectionMonthlyLimit ?? '—'}</td><td>{row.payoutLimit ?? '—'}</td><td>{row.conversionLimit ?? '—'}</td></tr>)}
            </tbody></table></div>}
          </Card>
        </div>
        <Card title="Save reversible controls" subtitle="Every update is recorded in the platform audit log with your reason.">
          <Field label="Audit reason"><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="Explain why these control changes are needed" /></Field>
          <Err error={save.error} />
          <Btn disabled={!canSave} onClick={() => save.mutate({
            ...(changedActions.size ? {
              controls: Object.fromEntries(Array.from(changedActions, (action) => [action, controls[action]])),
            } : {}),
            payoutSafety: {
              largePayoutThresholds: Object.fromEntries(thresholdEntries.map(([currency, amount]) => [currency, Number(amount)])),
              dualApprovalEnabled: dualApproval,
              destinationChangeRequiresDualApproval: true,
            },
            reason: reason.trim(),
          })}>{save.isPending && <LoaderCircle size={14} className="spin" />}Save control changes</Btn>
        </Card>
      </div>}
    </Async>
  </>;
}

export function AdminFeesPage() { return <G><FeesInner /></G>; }
function FeesInner() {
  const q = useListAdminFeeSchedules();
  const [edit, setEdit] = useState<{ s: AdminFeeSchedule | null } | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Fee schedules" subtitle="A global default plus optional per-merchant overrides." action={<Btn onClick={() => setEdit({ s: null })} testId="button-new-fee"><Plus size={15} />Set schedule</Btn>} />
    <Async q={q} empty={!items.length} emptyTitle="No fee schedules saved" emptyBody="Without a saved schedule, merchants see the platform default reported by the server." emptyAction={<Btn onClick={() => setEdit({ s: null })}>Set global schedule</Btn>}><div className="table-wrap"><table className="dt"><thead><tr><th>Scope</th><th className="num">Percentage</th><th className="num">Flat</th><th className="num">FX markup</th><th>Updated</th><th /></tr></thead><tbody>
      {items.map((s) => <tr key={s.id} data-testid={`row-fee-${s.id}`}><td><strong>{s.merchantId === null ? 'Global default' : `Merchant #${s.merchantId}`}</strong></td><td className="num">{s.percentage}%</td><td className="num">{money(s.flatAmount, s.currency)}</td><td className="num">{s.fxMarkupBps} bps</td><td>{fmtDate(s.updatedAt)}</td><td><div className="row-actions"><Btn variant="secondary" small onClick={() => setEdit({ s })}><Pencil size={13} />Edit</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <FeeEdit s={edit.s} onClose={() => setEdit(null)} />}</>;
}
function FeeEdit({ s, onClose }: { s: AdminFeeSchedule | null; onClose: () => void }) {
  const up = useUpdateAdminFeeSchedule();
  const inv = useInvalidateAll();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const mid = String(f.get('mid')).trim();
    up.mutate({ data: { merchantId: mid ? Number(mid) : null, percentage: Number(f.get('pct')), flatAmount: Number(f.get('flat')), currency: String(f.get('cur')), fxMarkupBps: Number(f.get('bps')) } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  return <Modal title={s ? 'Edit fee schedule' : 'Set fee schedule'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <Field label="Merchant ID" hint="Leave blank for the global default"><input name="mid" type="number" min="1" defaultValue={s?.merchantId ?? ''} readOnly={!!s} data-testid="input-fee-merchant" /></Field>
    <div className="form-grid"><Field label="Percentage (0-100)"><input name="pct" type="number" step="0.01" min="0" max="100" required defaultValue={s?.percentage ?? ''} data-testid="input-fee-pct" /></Field>
      <Field label="Flat amount"><input name="flat" type="number" step="0.01" min="0" required defaultValue={s?.flatAmount ?? 0} /></Field>
      <Field label="Flat currency"><select name="cur" defaultValue={s?.currency ?? 'USD'}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
      <Field label="FX markup (bps)"><input name="bps" type="number" step="1" min="0" max="10000" required defaultValue={s?.fxMarkupBps ?? 0} /></Field></div>
    <Err error={up.error} /><Btn type="submit" disabled={up.isPending} testId="button-save-fee">{up.isPending && <LoaderCircle size={14} className="spin" />}Save schedule</Btn></form></Modal>;
}

export function AdminExchangePage() { return <G><RatesInner /></G>; }
function RatesInner() {
  const q = useListAdminFxRates();
  const up = useUpdateAdminFxRate();
  const inv = useInvalidateAll();
  const [edit, setEdit] = useState<{ r: AdminFxRate | null } | null>(null);
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Exchange rates" subtitle="Rates feed merchant quotes only. They do not settle funds with a provider." action={<Btn onClick={() => setEdit({ r: null })} testId="button-new-rate"><Plus size={15} />New rate</Btn>} />
    <WalletFxSpreadSettings />
    <Err error={up.error} />
    <Async q={q} empty={!items.length} emptyTitle="No exchange rates" emptyBody="Merchants cannot get quotes until an active rate exists." emptyAction={<Btn onClick={() => setEdit({ r: null })}>Create rate</Btn>}><div className="table-wrap"><table className="dt"><thead><tr><th>Pair</th><th className="num">Rate</th><th>Source</th><th>Effective</th><th>Expires</th><th>State</th><th /></tr></thead><tbody>
      {items.map((r) => <tr key={r.id} data-testid={`row-rate-${r.id}`}><td><strong>{r.from} / {r.to}</strong></td><td className="num mono">{r.rate}</td><td>{r.source}</td><td>{fmtDate(r.effectiveAt)}</td><td>{fmtDate(r.expiresAt)}</td><td><Pill value={r.active ? 'active' : 'disabled'} /></td><td><div className="row-actions"><Btn variant="secondary" small onClick={() => setEdit({ r })}><Pencil size={13} />Edit</Btn><Btn variant="quiet" small disabled={up.isPending} onClick={() => up.mutate({ id: r.id, data: { active: !r.active } }, { onSuccess: () => { void inv(); } })}>{r.active ? 'Deactivate' : 'Activate'}</Btn></div></td></tr>)}
    </tbody></table></div></Async>
    {edit && <RateEdit r={edit.r} onClose={() => setEdit(null)} />}</>;
}
function RateEdit({ r, onClose }: { r: AdminFxRate | null; onClose: () => void }) {
  const create = useCreateAdminFxRate();
  const up = useUpdateAdminFxRate();
  const inv = useInvalidateAll();
  const err = create.error || up.error;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const exp = String(f.get('exp') || '');
    const expiresAt = exp ? new Date(exp).toISOString() : null;
    const done = { onSuccess: () => { void inv(); onClose(); } };
    if (r) up.mutate({ id: r.id, data: { rate: Number(f.get('rate')), expiresAt } }, done);
    else create.mutate({ data: { from: String(f.get('from')), to: String(f.get('to')), rate: Number(f.get('rate')), source: String(f.get('source')).trim(), expiresAt } }, done);
  }
  return <Modal title={r ? `Edit ${r.from} / ${r.to}` : 'New exchange rate'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    {!r && <div className="form-grid"><Field label="From"><select name="from" defaultValue="USD">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field><Field label="To"><select name="to" defaultValue="KES">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></Field></div>}
    <Field label="Rate" hint="Units of the target currency per one unit of source"><input name="rate" type="number" step="any" min="0" required defaultValue={r?.rate ?? ''} data-testid="input-rate" /></Field>
    {!r && <Field label="Source"><input name="source" required minLength={2} maxLength={150} placeholder="Treasury desk" data-testid="input-rate-source" /></Field>}
    <Field label="Expires" hint="Optional"><input name="exp" type="datetime-local" defaultValue={r?.expiresAt ? r.expiresAt.slice(0, 16) : ''} /></Field>
    <Err error={err} /><Btn type="submit" disabled={create.isPending || up.isPending} testId="button-save-rate">{(create.isPending || up.isPending) && <LoaderCircle size={14} className="spin" />}Save rate</Btn></form></Modal>;
}

function WalletFxSpreadSettings() {
  const settings = useGetAdminPlatformSettings();
  const save = useUpdateAdminPlatformSettings();
  const invalidate = useInvalidateAll();
  const currencies = CURRENCIES.filter((currency) => currency !== "SLL");
  const [spreads, setSpreads] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings.data) return;
    setSpreads(Object.fromEntries(currencies.map((currency) => [
      currency,
      String(settings.data.walletFxCurrencySpreads[currency] ?? 0),
    ])));
  }, [settings.data]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const walletFxCurrencySpreads = Object.fromEntries(currencies.map((currency) => [
      currency,
      Number(spreads[currency] ?? 0),
    ]));
    save.mutate({ data: { walletFxCurrencySpreads } }, { onSuccess: () => { void invalidate(); } });
  }

  return <Card title="Wallet FX system profit margins" subtitle="Admin-set target-currency margins are applied before the wallet fee schedule.">
    <form className="form-stack" onSubmit={submit}>
      <Note>Live rates use CurrencyAPI when configured, then ExchangeRate-API, Frankfurter, and the Fawaz reference feed. Rates are cached for six hours and sources older than 48 hours are rejected. Add or replace the CurrencyAPI key in <a className="text-link" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/admin/credentials`}>Provider credentials</a>. These system margins are added to any merchant schedule markup; the combined markup must stay below 10,000 bps. SLL conversion remains disabled.</Note>
      <Async q={settings}>
        <div className="form-grid">
          {currencies.map((currency) => <Field key={currency} label={`${currency} system margin (bps)`} hint="Withheld from the market-rate target amount before fees">
            <input
              type="number"
              min="0"
              max="10000"
              step="1"
              required
              value={spreads[currency] ?? ""}
              onChange={(event) => setSpreads((current) => ({ ...current, [currency]: event.target.value }))}
              data-testid={`input-wallet-fx-spread-${currency}`}
            />
          </Field>)}
        </div>
      </Async>
      <Err error={save.error} />
      <Btn type="submit" disabled={!settings.data || save.isPending} testId="button-save-wallet-fx-spreads">
        {save.isPending && <LoaderCircle size={14} className="spin" />}Save wallet FX spreads
      </Btn>
    </form>
  </Card>;
}

const CRED_FIELDS: Record<string, string[]> = {
  paystack: ['PAYSTACK_SECRET_KEY'], payhero: ['PAYHERO_USERNAME', 'PAYHERO_PASSWORD', 'PAYHERO_CHANNEL_ID'], payzaapi: ['PAYZAAPI_API_KEY', 'PAYZA_PUBLIC_KEY', 'PAYZA_SECRET_KEY', 'PAYZA_WEBHOOK_SECRET'],
  currencyapi: ['CURRENCYAPI_API_KEY'],
  didit: ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID'],
  cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  geoapify: ['GEOAPIFY_API_KEY'],
  statum: ['STATUM_CONSUMER_KEY', 'STATUM_CONSUMER_SECRET', 'STATUM_CALLBACK_TOKEN'],
};
const OPTIONAL = new Set(['DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID']);
const REQUIRED_HINT: Record<string, string> = {
  PAYZA_PUBLIC_KEY: 'Required for the existing Payza rail',
  PAYZA_SECRET_KEY: 'Required for the existing Payza rail',
  GEOAPIFY_API_KEY: 'Used only by the server for reverse geocoding. Never sent to applicant browsers.',
  STATUM_CALLBACK_TOKEN: 'At least 32 characters. Use a unique random token; it authenticates Statum callback requests.',
};
const PLAIN = new Set(['PAYZA_PUBLIC_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_KYB_WORKFLOW_ID', 'PAYHERO_CHANNEL_ID', 'CLOUDINARY_CLOUD_NAME']);

export function AdminCredentialsPage() { return <G><CredInner /></G>; }
function CredInner() {
  const q = useListAdminProviderCredentials();
  const save = useSaveAdminProviderCredentials();
  const inv = useInvalidateAll();
  const [edit, setEdit] = useState<ProviderCredential | null>(null);
  const [rm, setRm] = useState<ProviderCredential | null>(null);
  const del = useDeleteAdminProviderCredentials();
  const [off, setOff] = useState<ProviderCredential | null>(null);
  const items = q.data?.items ?? [];
  const statumCredential = items.find((item) => item.provider === 'statum');
  const statumReady = Boolean(statumCredential?.configured && statumCredential.enabled);
  const statumAccount = useGetAdminStatumAccount({ query: { queryKey: getGetAdminStatumAccountQueryKey(), enabled: statumReady, refetchInterval: 60_000 } });
  return <><Heading eyebrow="ADMIN" title="Provider credentials" subtitle="Secrets are encrypted at rest. Only masked values are ever shown." />
    {q.data && !q.data.vaultReady && <Note tone="warn">The encrypted vault is not ready on the server. Saving credentials will fail until vault encryption is configured.</Note>}
    <Err error={save.error} />
    <Card title="Statum airtime account" subtitle="Platform-level Statum balance and funding details. This is separate from merchant airtime wallets.">
      {statumReady
        ? <Async q={statumAccount}>
          {statumAccount.data && <div className="form-stack">
            <div><span className="sub">Available Statum balance</span><div className="metric-value">{money(statumAccount.data.balance, 'KES')}</div></div>
            <div><span className="sub">M-Pesa funding code</span><p>{statumAccount.data.topupCode ?? 'Not provided by Statum; use the funding instructions in the Statum portal.'}</p></div>
            <div><span className="sub">Registered callback URL</span><code className="mono" style={{ display: 'block', overflowWrap: 'anywhere' }}>{statumAccount.data.callbackUrl}</code><CopyBtn text={statumAccount.data.callbackUrl} /></div>
            <span className="sub">Balance checked {fmtDate(statumAccount.data.checkedAt)}. The callback URL includes the secret callback token; configure it only in Statum’s trusted callback settings.</span>
          </div>}
        </Async>
        : <Note>Configure and enable Statum credentials below to load the platform account balance and funding details.</Note>}
    </Card>
    <Async q={q} empty={!items.length} emptyTitle="No providers reported" emptyBody="The server returned no provider entries."><div className="cards" style={{ marginTop: 12 }}>
      {items.map((c) => <div className="card-lite" key={c.provider} data-testid={`card-provider-${c.provider}`}>
        <header><strong>{nice(c.provider)}</strong><Pill value={c.configured ? (c.enabled ? 'ready' : 'disabled') : 'not_started'} /></header>
        <span className="sub">Storage: {nice(c.storage)} {c.updatedAt ? `- updated ${fmtDate(c.updatedAt)}` : ''}</span>
        <div className="fields-list">{[...c.fields, ...(CRED_FIELDS[c.provider] ?? []).filter((n) => !c.fields.some((f) => f.name === n)).map((n) => ({ name: n, present: false, masked: '' }))].map((f) => <div key={f.name}><span>{f.name}</span><code>{f.present ? f.masked : 'not set'}</code></div>)}</div>
        <div className="setting-row" style={{ padding: '6px 0' }}><span>Enabled</span><Switch on={c.enabled} label={`${c.provider} enabled`} disabled={!c.configured || save.isPending} onChange={(v) => { if (v) save.mutate({ provider: c.provider, data: { enabled: true, credentials: {} } }, { onSuccess: () => { void inv(); } }); else setOff(c); }} /></div>
        <div className="row-actions"><Btn variant="secondary" small onClick={() => { save.reset(); setEdit(c); }} testId={`button-edit-${c.provider}`}><Pencil size={13} />{c.configured ? 'Replace' : 'Add'}</Btn>{c.storage === 'encrypted_vault' && <Btn variant="danger" small onClick={() => setRm(c)}><Trash2 size={13} />Delete</Btn>}</div>
      </div>)}</div></Async>
    {off && <Confirm title={`Disable ${nice(off.provider)}`} body="Routes and features that depend on this provider stop working immediately. Stored credentials are kept." confirmLabel="Disable provider" pending={save.isPending} error={save.error} onClose={() => { setOff(null); save.reset(); }} onConfirm={() => save.mutate({ provider: off.provider, data: { enabled: false, credentials: {} } }, { onSuccess: () => { void inv(); setOff(null); } })} />}
    {edit && <CredEdit c={edit} onClose={() => setEdit(null)} />}
    {rm && <Confirm title={`Delete ${nice(rm.provider)} credentials`} body="Stored secrets are removed from the vault. The provider stops working unless environment credentials exist." confirmLabel="Delete credentials" pending={del.isPending} error={del.error} onClose={() => { setRm(null); del.reset(); }} onConfirm={() => del.mutate({ provider: rm.provider }, { onSuccess: () => { void inv(); setRm(null); } })} />}</>;
}
function CredEdit({ c, onClose }: { c: ProviderCredential; onClose: () => void }) {
  const save = useSaveAdminProviderCredentials();
  const inv = useInvalidateAll();
  const [enabled, setEnabled] = useState(true);
  const names = [...new Set([...c.fields.map((f) => f.name), ...(CRED_FIELDS[c.provider] ?? [])])];
  const hasSavedPayheroChannelId = c.fields.some((field) => field.name === 'PAYHERO_CHANNEL_ID' && field.present);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credentials: Record<string, string> = {};
    names.forEach((n) => { const v = String(f.get(n) || '').trim(); if (v) credentials[n] = v; });
    save.mutate({ provider: c.provider, data: { enabled, credentials } }, { onSuccess: () => { void inv(); onClose(); } });
  }
  const description = c.provider === 'payhero'
    ? 'Enter the PayHero username and password. The channel ID is still required; leave it blank to keep the saved value.'
    : c.provider === 'didit'
      ? 'KYC sessions use the API key and workflow IDs. Webhook notifications are verified through Didit’s decision API, and the page also polls while open; no webhook secret is needed.'
      : c.provider === 'geoapify'
        ? 'Open https://myprojects.geoapify.com/, sign in or create an account, select or create a project, and copy its API key. Paste it here. This key is used server-side; the browser never receives it.'
      : c.provider === 'statum'
        ? 'Enter the Statum consumer key, consumer secret, and a unique random callback token of at least 32 characters. The admin account view provides the exact callback URL to register with Statum.'
    : 'Values replace what is stored; blank fields are cleared. Enter every value you want to retain. Existing secrets are never displayed.';
  return <Modal title={`${nice(c.provider)} credentials`} description={description} onClose={onClose}><form className="form-stack" onSubmit={submit} autoComplete="off">
    {names.map((n) => {
      const hint = c.provider === 'payhero' && n === 'PAYHERO_CHANNEL_ID'
        ? hasSavedPayheroChannelId ? 'Leave blank to keep the saved channel ID, or enter a new one to replace it.' : 'Required by PayHero for payment requests.'
        : OPTIONAL.has(n) ? 'Optional here, but required before verification sessions can start' : REQUIRED_HINT[n];
      const label = c.provider === 'payhero'
        ? ({ PAYHERO_USERNAME: 'Username', PAYHERO_PASSWORD: 'Password', PAYHERO_CHANNEL_ID: 'Channel ID' } as Record<string, string>)[n] ?? n
        : n;
      return <Field key={n} label={label} hint={hint}><input name={n} type={PLAIN.has(n) ? 'text' : 'password'} required={c.provider === 'statum'} autoComplete="off" spellCheck={false} placeholder={c.fields.find((f) => f.name === n)?.present ? c.fields.find((f) => f.name === n)?.masked : ''} data-testid={`input-${n}`} /></Field>;
    })}
    <div className="setting-row"><span>Enable provider</span><Switch on={enabled} onChange={setEnabled} label="enable provider" /></div>
    <Err error={save.error} /><Btn type="submit" disabled={save.isPending} testId="button-save-credentials">{save.isPending && <LoaderCircle size={14} className="spin" />}Save to vault</Btn></form></Modal>;
}

type PlatformFlagSetting = Pick<PlatformSettings, 'newMerchantSignups' | 'paymentsEnabled' | 'payoutsEnabled' | 'refundsEnabled' | 'apiAccessEnabled' | 'sandboxApiEnabled' | 'kycRequired'>;
const SETTINGS: [keyof PlatformFlagSetting, string, string][] = [
  ['newMerchantSignups', 'New merchant sign-ups', 'Allow new businesses to register.'],
  ['paymentsEnabled', 'Payments', 'Allow new collections to start.'],
  ['payoutsEnabled', 'Payouts', 'Allow payouts to be requested.'],
  ['refundsEnabled', 'Refunds', 'Allow refunds to be recorded.'],
  ['apiAccessEnabled', 'API access', 'Allow API key authenticated requests.'],
  ['sandboxApiEnabled', 'Sandbox API', 'Allow gp_test_ keys to use isolated simulated transactions.'],
  ['kycRequired', 'Verification required', 'Require approved KYC before activity.'],
];
export function AdminSettingsPage() { return <G><SettingsInner /></G>; }
type BrandingFormValues = Pick<PlatformSettings, 'platformName' | 'baseCurrency' | 'contactEmail' | 'contactPhone' | 'contactAddress' | 'contactWhatsapp'> & {
  logoUrl: string;
  faviconUrl: string;
};
function SettingsInner() {
  const q = useGetAdminPlatformSettings();
  const up = useUpdateAdminPlatformSettings();
  const cloudinaryStatus = useGetAdminCloudinaryUploadStatus();
  const cloudinarySignature = useCreateAdminCloudinaryUploadSignature();
  const providerCredentials = useListAdminProviderCredentials();
  const currencyAvailability = useListAdminCollectionCurrencyAvailability();
  const supportedCurrencies = useListSupportedCurrencies();
  const updateCurrencyAvailability = useUpdateAdminCollectionCurrencyAvailability();
  const queryClient = useQueryClient();
  const inv = useInvalidateAll();
  const [off, setOff] = useState<string | null>(null);
  const [branding, setBranding] = useState<BrandingFormValues | null>(null);
  const [cloudinaryEdit, setCloudinaryEdit] = useState<ProviderCredential | null>(null);
  const [geoapifyEdit, setGeoapifyEdit] = useState<ProviderCredential | null>(null);
  const cloudinaryCredential = providerCredentials.data?.items.find((item) => item.provider === 'cloudinary');
  const geoapifyCredential = providerCredentials.data?.items.find((item) => item.provider === 'geoapify');
  useEffect(() => {
    if (!q.data) return;
    setBranding({
      platformName: q.data.platformName,
      baseCurrency: q.data.baseCurrency,
      contactEmail: q.data.contactEmail,
      contactPhone: q.data.contactPhone,
      contactAddress: q.data.contactAddress,
      contactWhatsapp: q.data.contactWhatsapp,
      logoUrl: q.data.logoUrl ?? '',
      faviconUrl: q.data.faviconUrl ?? '',
    });
  }, [q.data]);
  function updateBranding<K extends keyof BrandingFormValues>(key: K, value: BrandingFormValues[K]) {
    setBranding((current) => current ? { ...current, [key]: value } : current);
  }
  function submitBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!branding) return;
    up.mutate({ data: {
      ...branding,
      baseCurrency: branding.baseCurrency.toUpperCase(),
      contactEmail: branding.contactEmail.trim(),
      contactPhone: branding.contactPhone.trim(),
      contactAddress: branding.contactAddress.trim(),
      contactWhatsapp: branding.contactWhatsapp.trim(),
      logoUrl: branding.logoUrl.trim() || null,
      faviconUrl: branding.faviconUrl.trim() || null,
    } }, { onSuccess: () => { void inv(); } });
  }
  return <><Heading eyebrow="ADMIN" title="Platform settings" subtitle="Brand identity, customer contact details and platform-wide feature switches. Changes are audited." />
    <Err error={up.error} />
    <Async q={q}><div className="form-stack">
      <Card title="Cloudinary API settings" subtitle="Upload signatures are generated server-side. Credentials are encrypted at rest and masked after saving.">
        {cloudinaryStatus.isLoading ? <span className="sub">Checking Cloudinary configuration…</span>
          : cloudinaryStatus.isError ? <Err error={cloudinaryStatus.error} />
            : <div className="form-stack">
              {cloudinaryStatus.data?.configured
                ? <Note>Cloudinary uploads are enabled{cloudinaryStatus.data.cloudName ? ` for ${cloudinaryStatus.data.cloudName}` : ''}.</Note>
                : <Note tone="warn">Cloudinary uploads are not configured. Add the Cloud Name, API Key, and API Secret in Provider credentials to enable uploads.</Note>}
              <div className="row-actions">
                <Btn
                  variant="secondary"
                  disabled={!cloudinaryCredential}
                  onClick={() => cloudinaryCredential && setCloudinaryEdit(cloudinaryCredential)}
                  testId="button-configure-cloudinary"
                >
                  <Pencil size={13} />{cloudinaryStatus.data?.configured ? 'Replace Cloudinary credentials' : 'Configure Cloudinary credentials'}
                </Btn>
                <a className="text-link" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/admin/credentials`}>All provider credentials</a>
              </div>
              {!cloudinaryCredential && providerCredentials.isLoading && <span className="sub">Loading credential settings…</span>}
              {!cloudinaryCredential && providerCredentials.isError && <Err error={providerCredentials.error} />}
            </div>}
      </Card>
      <Card title="Device address lookup" subtitle="Geoapify reverse geocoding is used by unverified merchant applications. Applicant pages show the required Geoapify attribution.">
        {providerCredentials.isLoading ? <span className="sub">Checking address lookup configuration…</span>
          : providerCredentials.isError ? <Err error={providerCredentials.error} />
            : <div className="form-stack">
              <Note>Get the key from <a href="https://myprojects.geoapify.com/" target="_blank" rel="noreferrer">Geoapify My Projects</a>: sign in, create or select a project, then copy its API key into Greenpay’s Geoapify credentials.</Note>
              {geoapifyCredential?.configured
                ? <Note>Automatic address lookup is enabled. Applicants can still choose manual review.</Note>
                : <Note tone="warn">Automatic lookup is unavailable. Applicants can still submit a manual address for review.</Note>}
              <div className="row-actions">
                <Btn
                  variant="secondary"
                  disabled={!geoapifyCredential}
                  onClick={() => geoapifyCredential && setGeoapifyEdit(geoapifyCredential)}
                  testId="button-configure-geoapify"
                >
                  <Pencil size={13} />{geoapifyCredential?.configured ? 'Replace Geoapify API key' : 'Configure Geoapify API key'}
                </Btn>
                <a className="text-link" href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/admin/credentials`}>All provider credentials</a>
              </div>
            </div>}
      </Card>
      <Card title="Platform identity" subtitle="Public details shown across the platform and onboarding.">
        {branding && <form className="form-stack" onSubmit={submitBranding}>
          <Field label="Platform name"><input value={branding.platformName} onChange={(e) => updateBranding('platformName', e.target.value)} required minLength={1} maxLength={100} data-testid="input-platform-name" /></Field>
          <div className="form-grid">
            <Field label="Base currency" hint="Display and new-merchant onboarding default only; changing it never converts or changes existing balances."><select value={branding.baseCurrency} onChange={(e) => updateBranding('baseCurrency', e.target.value)} data-testid="select-platform-base-currency">{[...new Set([branding.baseCurrency, ...CURRENCIES])].map((currency) => <option key={currency}>{currency}</option>)}</select></Field>
            <Field label="Logo URL" hint="Optional HTTPS image URL"><input type="url" value={branding.logoUrl} onChange={(e) => updateBranding('logoUrl', e.target.value)} placeholder="https://…" data-testid="input-platform-logo-url" /></Field>
            <Field label="Favicon URL" hint="Optional HTTPS image URL"><input type="url" value={branding.faviconUrl} onChange={(e) => updateBranding('faviconUrl', e.target.value)} placeholder="https://…" data-testid="input-platform-favicon-url" /></Field>
          </div>
          <div className="form-grid">
            <CloudinaryImageUpload
              label="Upload platform logo"
              value={branding.logoUrl}
              description="Upload a logo to Cloudinary, then save platform identity."
              disabled={!cloudinaryStatus.data?.configured}
              getSignature={() => cloudinarySignature.mutateAsync(undefined)}
              onUploaded={(url) => updateBranding('logoUrl', url)}
            />
            <CloudinaryImageUpload
              label="Upload platform favicon"
              value={branding.faviconUrl}
              description="Upload an icon to Cloudinary, then save platform identity."
              disabled={!cloudinaryStatus.data?.configured}
              getSignature={() => cloudinarySignature.mutateAsync(undefined)}
              onUploaded={(url) => updateBranding('faviconUrl', url)}
            />
          </div>
          <div className="form-grid">
            <Field label="Contact email"><input type="email" value={branding.contactEmail} onChange={(e) => updateBranding('contactEmail', e.target.value)} maxLength={254} data-testid="input-platform-contact-email" /></Field>
            <Field label="Contact phone"><input type="tel" value={branding.contactPhone} onChange={(e) => updateBranding('contactPhone', e.target.value)} maxLength={40} data-testid="input-platform-contact-phone" /></Field>
            <Field label="WhatsApp contact" hint="Use an international phone number or an https://wa.me link"><input value={branding.contactWhatsapp} onChange={(e) => updateBranding('contactWhatsapp', e.target.value)} maxLength={100} data-testid="input-platform-contact-whatsapp" /></Field>
          </div>
          <Field label="Contact address"><textarea value={branding.contactAddress} onChange={(e) => updateBranding('contactAddress', e.target.value)} maxLength={250} data-testid="input-platform-contact-address" /></Field>
          <Btn type="submit" disabled={up.isPending} testId="button-save-platform-branding">{up.isPending && <LoaderCircle size={14} className="spin" />}Save platform identity</Btn>
        </form>}
      </Card>
      {cloudinaryEdit && <CredEdit c={cloudinaryEdit} onClose={() => setCloudinaryEdit(null)} />}
      {geoapifyEdit && <CredEdit c={geoapifyEdit} onClose={() => setGeoapifyEdit(null)} />}
      <Card title="Feature controls" subtitle="Platform-wide switches. Changes apply immediately and are audited.">
        {q.data && SETTINGS.map(([k, t, d]) => <div className="setting-row" key={k}><div><strong>{t}</strong><span>{d}</span></div><Switch on={q.data[k]} label={t} disabled={up.isPending} onChange={(v) => { if (v) up.mutate({ data: { [k]: v } }, { onSuccess: () => { void inv(); } }); else setOff(k); }} /></div>)}
      </Card>
      <Card title="Sandbox transaction defaults" subtitle="Configure the outcome used by sandbox requests that do not specify a testOutcome.">
        <Note>Sandbox keys use /api/sandbox/v1 and write only to sandbox transaction records. They never contact a payment provider or affect live transactions. Disabling the Sandbox API blocks requests but retains existing test records.</Note>
        {q.data && <Field label="Default simulated outcome">
          <select
            value={q.data.sandboxDefaultOutcome}
            disabled={up.isPending}
            onChange={(event) => up.mutate({
              data: { sandboxDefaultOutcome: event.target.value as PlatformSettings['sandboxDefaultOutcome'] },
            }, { onSuccess: () => { void inv(); } })}
            data-testid="select-sandbox-default-outcome"
          >
            <option value="pending">Pending</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
        </Field>}
      </Card>
      <Card title="Collection currency launch" subtitle="Control whether new collections may start in each supported currency.">
        <Note tone="warn">Turning a currency off prevents new collections and displays “Coming soon” at checkout. Existing payment links remain visible and editable, but customers cannot collect in that currency until it is enabled again.</Note>
        <Async q={supportedCurrencies}>
          <Async q={currencyAvailability}>
            <Err error={updateCurrencyAvailability.error} />
            <div className="form-stack">
              {(supportedCurrencies.data?.items ?? []).map((currency) => {
                const override = currencyAvailability.data?.items.find((item) => item.currency === currency.code);
                const enabled = override?.enabled ?? true;
                return <div className="setting-row" key={currency.code} data-testid={`row-collection-currency-${currency.code}`}>
                  <div><strong>{currency.code} · {currency.name}</strong><span>{enabled ? 'Active for new collections' : 'Coming soon · new collections blocked'}{override ? ` · Updated ${fmtDate(override.updatedAt)} by ${override.actorUserId}` : ' · Default active'}</span></div>
                  <Switch on={enabled} label={`${currency.code} collection availability`} disabled={updateCurrencyAvailability.isPending} onChange={(next) => updateCurrencyAvailability.mutate({ data: { currency: currency.code as never, enabled: next } }, { onSuccess: async () => {
                    await queryClient.invalidateQueries({ queryKey: getListAdminCollectionCurrencyAvailabilityQueryKey() });
                    await queryClient.invalidateQueries();
                  } })} />
                </div>;
              })}
            </div>
          </Async>
        </Async>
      </Card>
    </div></Async>
    {off && <Confirm title="Turn off this control" body="This applies platform-wide immediately for every merchant." confirmLabel="Turn off" pending={up.isPending} error={up.error} onClose={() => { setOff(null); up.reset(); }} onConfirm={() => up.mutate({ data: { [off]: false } }, { onSuccess: () => { void inv(); setOff(null); } })} />}</>;
}

export function AdminAuditPage() { return <G><AuditInner /></G>; }
function AuditInner() {
  const [page, setPage] = useState(1);
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const q = useListAdminAuditLog({ page, ...(user ? { user } : {}), ...(action ? { action } : {}), ...(search ? { search } : {}) });
  const items = q.data?.items ?? [];
  return <><Heading eyebrow="ADMIN" title="Audit log" subtitle="Server-recorded user and API activity, including the acting identity, method, route and response status." />
    <div className="toolbar"><div className="search-box"><Search size={14} /><input placeholder="Search actor, target or route" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} data-testid="input-audit-search" /></div>
      <input aria-label="Filter by user or API identity" placeholder="User / API identity" value={user} onChange={(e) => { setPage(1); setUser(e.target.value); }} data-testid="input-audit-user" />
      <input aria-label="Filter by action" placeholder="Action" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} data-testid="input-audit-action" /></div>
    <Async q={q} empty={!items.length} emptyTitle="No audit entries" emptyBody="Administrative and meaningful signed-in user/API actions are recorded here."><div className="table-wrap"><table className="dt"><thead><tr><th>When</th><th>User / API actor</th><th>Action</th><th>Method</th><th>Route</th><th>Status</th><th>Target</th><th>Details</th></tr></thead><tbody>
      {items.map((a) => <tr key={a.id} data-testid={`row-audit-${a.id}`}><td>{fmtDate(a.createdAt)}</td><td className="mono" style={{ fontSize: 12 }}>{a.actor}</td><td><strong>{nice(a.action)}</strong></td><td>{a.method || '—'}</td><td className="mono">{a.route || '—'}</td><td>{a.statusCode ?? '—'}</td><td>{a.target}</td><td>{a.details || '—'}</td></tr>)}
    </tbody></table></div>{q.data && <Pager page={page} total={q.data.total} perPage={50} onPage={setPage} />}</Async></>;
}
