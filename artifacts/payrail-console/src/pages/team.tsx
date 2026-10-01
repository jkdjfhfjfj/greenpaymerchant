import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, MailPlus, ShieldCheck, Trash2 } from "lucide-react";
import { SignIn, useAuth } from "@clerk/react";
import {
  useAcceptMerchantTeamInvitation,
  useCreateMerchantTeamInvitation,
  useListMerchantTeam,
  useRemoveMerchantTeamMember,
  useRevokeMerchantTeamInvitation,
  useUpdateMerchantTeamMember,
} from "@workspace/api-client-react";
import { Async, Btn, Card, Confirm, CopyBtn, Err, Field, Heading, Note, fmtDate, nice, useAccess, useInvalidateAll } from "@/components/kit";

type TeamRole = "finance" | "viewer";

export function MerchantTeamPage() {
  const access = useAccess();
  const team = useListMerchantTeam();
  const invite = useCreateMerchantTeamInvitation();
  const changeRole = useUpdateMerchantTeamMember();
  const remove = useRemoveMerchantTeamMember();
  const revoke = useRevokeMerchantTeamInvitation();
  const invalidate = useInvalidateAll();
  const [role, setRole] = useState<TeamRole>("finance");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<number | null>(null);
  const members = team.data?.members ?? [];
  const invitations = team.data?.invitations ?? [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") || "").trim();
    invite.mutate({ data: { email, role } }, {
      onSuccess: (created) => {
        setInviteLink(created.invitationUrl);
        form.reset();
        setRole("finance");
        void invalidate();
      },
    });
  }

  return <>
    <Heading eyebrow="MERCHANT / ACCESS" title="Team and permissions" subtitle="Invite finance operators and read-only accountants to the merchant workspace." />
    <div className="split">
      <Card title="Invite a teammate" subtitle="Invitation links expire after seven days and only work for the invited verified email.">
        <form className="form-stack" onSubmit={submit}>
          <Field label="Verified email address"><input name="email" type="email" autoComplete="email" maxLength={254} placeholder="finance@example.com" required data-testid="input-team-email" /></Field>
          <Field label="Role">
            <select value={role} onChange={(event) => setRole(event.target.value as TeamRole)} data-testid="select-team-role">
              <option value="finance">Finance operator</option>
              <option value="viewer">Read-only accountant / viewer</option>
            </select>
          </Field>
          <p className="sub">Greenpay email delivery is not configured. The link is shown once after creation so you can copy and deliver it securely.</p>
          <Err error={invite.error} />
          <Btn type="submit" disabled={invite.isPending} testId="button-create-team-invite">
            {invite.isPending ? <LoaderCircle size={15} className="spin" /> : <MailPlus size={15} />}
            Create invitation
          </Btn>
        </form>
        {inviteLink && <div className="notice" role="status" style={{ marginTop: 14 }}>
          <ShieldCheck size={16} />
          <div><strong>Invitation created — copy this private link now.</strong><p className="mono" style={{ overflowWrap: "anywhere", margin: "8px 0" }}>{inviteLink}</p><CopyBtn text={inviteLink} /></div>
        </div>}
      </Card>
      <Card title="Permission boundaries" subtitle="Payouts remain under the platform's independent approval workflow.">
        <div className="form-stack">
          <div><strong>Owner</strong><p className="sub">Full merchant control, including business profile, verification, API keys, webhooks, and team access.</p></div>
          <div><strong>Finance operator</strong><p className="sub">Can read merchant activity and perform permitted operational work. Cannot change merchant profile, KYC/KYB, API keys, webhooks, or team access.</p></div>
          <div><strong>Read-only accountant / viewer</strong><p className="sub">Can review permitted workspace records but every mutation is rejected by the server.</p></div>
          <Note tone="warn">Payment success is recorded only after provider confirmation. Team access does not bypass independent payout review.</Note>
        </div>
      </Card>
    </div>

    <Card title="Active team" subtitle={`Merchant owner: ${access.data?.role === "owner" ? "you" : "owner"} · The owner cannot be removed or downgraded.`}>
      <Err error={changeRole.error || remove.error} />
      <Async q={team} empty={!members.length} emptyTitle="No additional members" emptyBody="Your merchant owner account is the only active user so far.">
        <div className="table-wrap"><table className="dt">
          <thead><tr><th>Email</th><th>Access</th><th>Added</th><th /></tr></thead>
          <tbody>{members.map((member) => <tr key={member.id} data-testid={`row-team-member-${member.id}`}>
            <td><strong>{member.email}</strong><span className="sub">Active team member</span></td>
            <td><select aria-label={`Role for ${member.email}`} value={member.role === "owner" ? "finance" : member.role} onChange={(event) => changeRole.mutate({ id: member.id, data: { role: event.target.value as TeamRole } }, { onSuccess: () => { void invalidate(); } })} disabled={changeRole.isPending || member.role === "owner"} data-testid={`select-member-role-${member.id}`}>
              <option value="finance">Finance operator</option><option value="viewer">Read-only accountant / viewer</option>
            </select></td>
            <td>{fmtDate(member.createdAt)}</td>
            <td><Btn variant="danger" small disabled={remove.isPending || member.role === "owner"} onClick={() => setRemoveId(member.id)}><Trash2 size={13} />Remove</Btn></td>
          </tr>)}</tbody>
        </table></div>
      </Async>
    </Card>

    <Card title="Pending invitations" subtitle="Invitation links are returned only once at creation; revoke one here if it was not delivered securely.">
      <Err error={revoke.error} />
      <Async q={team} empty={!invitations.length} emptyTitle="No pending invitations" emptyBody="New invites remain pending for seven days or until accepted or revoked.">
        <div className="table-wrap"><table className="dt">
          <thead><tr><th>Recipient</th><th>Role</th><th>Expires</th><th /></tr></thead>
          <tbody>{invitations.map((invitation) => <tr key={invitation.id} data-testid={`row-team-invitation-${invitation.id}`}>
            <td><strong>{invitation.email}</strong><span className="sub">Link delivery required</span></td>
            <td>{invitation.role === "viewer" ? "Read-only accountant / viewer" : nice(invitation.role)}</td>
            <td>{fmtDate(invitation.expiresAt)}</td>
            <td><Btn variant="quiet" small disabled={revoke.isPending} onClick={() => revoke.mutate({ id: invitation.id }, { onSuccess: () => { void invalidate(); } })}><Trash2 size={13} />Revoke</Btn></td>
          </tr>)}</tbody>
        </table></div>
      </Async>
    </Card>
    {removeId !== null && <Confirm title="Remove team member" body="Their merchant access ends immediately. This does not affect the merchant owner." confirmLabel="Remove member" pending={remove.isPending} error={remove.error} onClose={() => { setRemoveId(null); remove.reset(); }} onConfirm={() => remove.mutate({ id: removeId }, { onSuccess: () => { void invalidate(); setRemoveId(null); } })} />}
  </>;
}

export function AcceptTeamInvitePage() {
  const auth = useAuth();
  const accept = useAcceptMerchantTeamInvitation();
  const invalidate = useInvalidateAll();
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token")?.trim() ?? "");
  useEffect(() => {
    if (!token || !auth.isSignedIn) return;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", cleanUrl.toString());
  }, [auth.isSignedIn, token]);
  const accepted = accept.data;
  if (!auth.isLoaded) return <div className="loading-state"><div className="skeleton-line wide" /><div className="skeleton-line" /></div>;
  if (!auth.isSignedIn) return <>
    <Heading eyebrow="MERCHANT / INVITATION" title="Sign in to continue" subtitle="The invitation can only be accepted by its verified recipient." />
    <Card title="Sign in with the invited account" subtitle="After sign-in, you will return here to accept the invitation.">
      {token ? <SignIn routing="hash" forceRedirectUrl={window.location.href} fallbackRedirectUrl={window.location.href} /> :
        <Note tone="danger">This invitation link is missing its private token. Ask the owner for a fresh invite.</Note>}
    </Card>
  </>;
  return <>
    <Heading eyebrow="MERCHANT / INVITATION" title={accepted ? "You're on the team" : "Accept team invitation"} subtitle="Invitation links are single-use, time-limited, and match the signed-in verified email address." />
    <Card title={accepted ? accepted.businessName : "Confirm your account"} subtitle={accepted ? `Access granted as ${accepted.role === "viewer" ? "read-only accountant / viewer" : "finance operator"}.` : "Continue only when signed in with the email address that received this invitation."}>
      {accepted ? <div className="form-stack"><Note>Your merchant access is active. Every request is checked against your current role.</Note><a className="btn btn-primary" href="/merchant">Open merchant workspace <ArrowRight size={15} /></a></div> :
        <div className="form-stack">
          {!token && <Note tone="danger">This invitation link is missing its private token. Ask the owner for a fresh invite.</Note>}
          <p className="sub">The invitation will be accepted only if your signed-in account has the exact verified recipient email. The owner can revoke an invitation before it is used.</p>
          <Err error={accept.error} />
          <Btn disabled={!token || accept.isPending} onClick={() => accept.mutate({ data: { token } }, { onSuccess: () => { void invalidate(); } })} testId="button-accept-team-invite">
            {accept.isPending && <LoaderCircle size={15} className="spin" />}Accept invitation
          </Btn>
        </div>}
    </Card>
  </>;
}