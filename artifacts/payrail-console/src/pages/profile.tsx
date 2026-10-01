import { useEffect } from 'react';
import { useUser, UserProfile } from '@clerk/react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Building2, CircleAlert, ShieldCheck } from 'lucide-react';
import { Form } from '@/components/ui/form';
import { businessContactProfile, saveBusinessContactProfile, type BusinessContact } from './support-api';
import '@/support.css';

interface ContactValues {
  contactName: string;
  email: string;
  phone: string;
}

export function ProfilePage() {
  useEffect(() => { document.title = 'Profile · Greenpay'; }, []);
  const { user } = useUser();
  const client = useQueryClient();
  const contact = useQuery({
    queryKey: ['business-contact'],
    queryFn: () => businessContactProfile(),
    staleTime: 15_000,
    refetchOnMount: 'always',
  });
  const form = useForm<ContactValues>({ defaultValues: { contactName: '', email: '', phone: '' } });
  useEffect(() => {
    if (contact.data) form.reset({
      contactName: contact.data.contactName ?? '',
      email: contact.data.email ?? '',
      phone: contact.data.phone ?? '',
    });
  }, [contact.data, form]);
  const save = useMutation({
    mutationFn: (values: ContactValues) => saveBusinessContactProfile({
      contactName: values.contactName.trim() || null,
      email: values.email.trim() || null,
      phone: values.phone.trim() || null,
    }),
    onSuccess: async (data) => {
      client.setQueryData(['business-contact'], data);
      form.reset({
        contactName: data.contactName ?? '',
        email: data.email ?? '',
        phone: data.phone ?? '',
      });
    },
  });
  const notOnboarded = contact.isError && contact.error.message.toLowerCase().includes('onboarding');

  return <main className="support-page profile-page">
    <header className="support-app-header"><div><a href="/" className="support-brand" data-testid="link-profile-home">greenpay<span>.</span></a><span className="support-header-divider">/</span><strong>Profile</strong></div><span className="profile-secure-label"><ShieldCheck size={14} /> ACCOUNT SETTINGS</span></header>
    <section className="support-heading-row">
      <div><div className="support-eyebrow"><BadgeCheck size={14} /> YOUR ACCOUNT</div><h1>Profile settings</h1><p>Manage your personal Clerk profile and business contact information.</p></div>
    </section>
    <div className="profile-layout">
      <section className="support-card profile-personal-card">
        <div className="profile-section-heading"><span className="profile-icon"><ShieldCheck size={18} /></span><div><h2>Personal profile</h2><p>Identity, sign-in methods, and account security are managed by your secure Clerk profile.</p></div></div>
        <div className="profile-personal-summary" data-testid="text-profile-personal-identity">
          <strong>{user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Signed-in account'}</strong>
          <span>{user?.primaryEmailAddress?.emailAddress ?? 'Email address is not available'}</span>
        </div>
        <div className="clerk-profile-shell"><UserProfile routing="hash" /></div>
      </section>
      <section className="support-card profile-business-card">
        <div className="profile-section-heading"><span className="profile-icon"><Building2 size={18} /></span><div><h2>Business contact</h2><p>Update the contact details Greenpay uses for business correspondence.</p></div></div>
        {contact.isLoading && <div className="support-skeleton" />}
        {contact.isError && <div className="support-error-state" role="alert" data-testid="text-business-contact-error">
          <CircleAlert size={17} /><span>{contact.error.message}</span>
          {notOnboarded ? <a href="/merchant" className="support-button support-button-quiet" data-testid="link-business-onboarding">Continue business onboarding</a> : <button type="button" className="support-button support-button-quiet" onClick={() => { void contact.refetch(); }} data-testid="button-retry-business-contact">Retry</button>}
        </div>}
        {contact.data && <Form {...form}>
          <form className="support-form profile-business-form" onSubmit={form.handleSubmit((values) => save.mutate(values))}>
            <div className="profile-business-name"><span>Registered business</span><strong data-testid="text-profile-business-name">{contact.data.businessName}</strong></div>
            <label className="support-field"><span>Business contact name</span><input {...form.register('contactName', { maxLength: 120 })} maxLength={120} data-testid="input-business-contact-name" /></label>
            <label className="support-field"><span>Business contact email</span><input {...form.register('email', { maxLength: 254 })} type="email" maxLength={254} data-testid="input-business-contact-email" /></label>
            <label className="support-field"><span>Business contact phone</span><input {...form.register('phone', { maxLength: 40 })} type="tel" maxLength={40} data-testid="input-business-contact-phone" /></label>
            <div className="profile-readonly-status"><span><ShieldCheck size={14} /> Verification status</span><strong data-testid="status-profile-kyc">{contact.data.kycStatus.replaceAll('_', ' ')}</strong></div>
            <p className="support-field-hint">Business name, legal ownership, and verification details are read-only here. Contact edits do not change your verification status or ownership records.</p>
            {save.isError && <div className="support-error" role="alert" data-testid="text-save-business-contact-error">{save.error.message}</div>}
            {save.isSuccess && <div className="support-saved-message" role="status" data-testid="status-business-contact-saved">Business contact details saved.</div>}
            <button type="submit" className="support-button support-button-primary" disabled={save.isPending} data-testid="button-save-business-contact">{save.isPending ? 'Saving…' : 'Save business contact'}</button>
          </form>
        </Form>}
      </section>
    </div>
  </main>;
}

export default ProfilePage;