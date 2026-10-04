import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Headphones, Send } from 'lucide-react';
import { Form } from '@/components/ui/form';
import { PlatformBrand, usePlatformBranding } from '@/components/platform-brand';
import { deliveryNotice, publicContactTicket, type ContactTicketInput, type ContactTicketReceipt } from './support-api';
import '@/support.css';

type ContactFormValues = ContactTicketInput & {
  category: NonNullable<ContactTicketInput['category']>;
};

export function ContactPage() {
  const branding = usePlatformBranding();
  useEffect(() => {
    const title = `Contact ${branding.platformName} Support`;
    const description = `Contact ${branding.platformName} about payments, your account, business verification or a technical issue. Do not include passwords or payment credentials.`;
    const publicBase = import.meta.env.VITE_PUBLIC_SITE_URL?.trim() || 'https://greenpay.co.ke';
    const canonicalUrl = new URL('/contact', `${publicBase.replace(/\/$/, '')}/`).toString();
    document.title = title;
    const setMeta = (selector: string, attribute: 'name' | 'property', key: string, content: string) => {
      let element = document.querySelector<HTMLMetaElement>(selector);
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attribute, key);
        document.head.append(element);
      }
      element.content = content;
    };
    setMeta('meta[name="description"]', 'name', 'description', description);
    setMeta('meta[name="robots"]', 'name', 'robots', 'index, follow');
    setMeta('meta[property="og:site_name"]', 'property', 'og:site_name', branding.platformName);
    setMeta('meta[property="og:title"]', 'property', 'og:title', title);
    setMeta('meta[property="og:description"]', 'property', 'og:description', description);
    setMeta('meta[property="og:url"]', 'property', 'og:url', canonicalUrl);
    setMeta('meta[property="og:type"]', 'property', 'og:type', 'website');
    setMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary');
    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title);
    setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description);
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = canonicalUrl;
  }, [branding.platformName]);
  const [receipt, setReceipt] = useState<ContactTicketReceipt | null>(null);
  const form = useForm<ContactFormValues>({
    defaultValues: { name: '', email: '', subject: '', category: 'other', message: '' },
  });
  const submit = useMutation({
    mutationFn: (values: ContactFormValues) => publicContactTicket({
      ...values,
      name: values.name.trim(),
      email: values.email.trim(),
      subject: values.subject.trim(),
      message: values.message.trim(),
    }),
    onSuccess: (result) => {
      setReceipt(result);
      form.reset();
    },
  });
  const whatsappDigits = branding.contactWhatsapp.replace(/\D/g, '');
  const whatsappUrl = /^https:\/\/wa\.me\/\d{7,15}\/?$/i.test(branding.contactWhatsapp)
    ? branding.contactWhatsapp
    : whatsappDigits.length >= 7 ? `https://wa.me/${whatsappDigits}` : null;

  return <main className="support-page public-contact-page">
    <header className="support-public-header">
      <a href="/" className="support-brand" aria-label={`${branding.platformName} home`} data-testid="link-greenpay-home"><PlatformBrand /></a>
      <a href="/sign-in" className="support-header-link" data-testid="link-contact-sign-in">Sign in</a>
    </header>
    <section className="support-hero">
      <div className="support-eyebrow"><Headphones size={15} /> WE'RE HERE TO HELP</div>
      <h1>Talk to {branding.platformName} support.</h1>
      <p>Share what you need help with and the support team will direct your request to the right place.</p>
    </section>
    <section className="support-public-card">
      {receipt ? <div className="support-success" role="status" data-testid="status-contact-submitted">
        <span className="support-success-icon"><CheckCircle2 size={27} /></span>
        <span className="support-eyebrow">REQUEST RECORDED</span>
        <h2>We have your message.</h2>
        <p>Your reference is <strong className="support-reference">{receipt.reference}</strong>. Keep it for your records.</p>
        <div className="support-notice">{deliveryNotice()}</div>
        <a className="support-button support-button-quiet" href="/" data-testid="link-contact-home"><ArrowLeft size={15} /> Back to {branding.platformName}</a>
      </div> : <>
        <Form {...form}>
          <form className="support-form" onSubmit={form.handleSubmit((values) => submit.mutate(values))}>
            <div className="support-form-grid">
              <label className="support-field"><span>Your name</span>
                <input {...form.register('name', { required: 'Enter your name.', maxLength: 120 })} autoComplete="name" maxLength={120} data-testid="input-contact-name" />
                {form.formState.errors.name && <small className="support-field-error">{form.formState.errors.name.message}</small>}
              </label>
              <label className="support-field"><span>Email address</span>
                <input {...form.register('email', { required: 'Enter your email.', maxLength: 254 })} type="email" autoComplete="email" maxLength={254} data-testid="input-contact-email" />
                {form.formState.errors.email && <small className="support-field-error">{form.formState.errors.email.message}</small>}
              </label>
            </div>
            <label className="support-field"><span>How can we help?</span>
              <select {...form.register('category')} data-testid="select-contact-category">
                <option value="payments">Payments</option>
                <option value="account">Account</option>
                <option value="verification">Business verification</option>
                <option value="technical">Technical issue</option>
                <option value="other">Something else</option>
              </select>
            </label>
            <label className="support-field"><span>Subject</span>
              <input {...form.register('subject', { required: 'Add a subject.', minLength: 3, maxLength: 180 })} maxLength={180} data-testid="input-contact-subject" />
              {form.formState.errors.subject && <small className="support-field-error">Subject must be between 3 and 180 characters.</small>}
            </label>
            <label className="support-field"><span>Message</span>
              <textarea {...form.register('message', { required: 'Write a message.', minLength: 10, maxLength: 8000 })} rows={6} maxLength={8000} placeholder="Include any details that will help us understand your request." data-testid="input-contact-message" />
              <small className="support-field-hint">10–8,000 characters. Please do not include passwords, secret keys, or full payment credentials.</small>
              {form.formState.errors.message && <small className="support-field-error">Message must be between 10 and 8,000 characters.</small>}
            </label>
            {submit.isError && <div className="support-error" role="alert" data-testid="text-contact-error">{submit.error.message}</div>}
            <button className="support-button support-button-primary" type="submit" disabled={submit.isPending} data-testid="button-contact-submit">
              <Send size={15} /> {submit.isPending ? 'Sending request…' : 'Send support request'}
            </button>
            <p className="support-form-foot">{deliveryNotice()}</p>
          </form>
        </Form>
      </>}
    </section>
    {(branding.contactEmail || branding.contactPhone || branding.contactAddress || whatsappUrl) && <section className="support-public-card" aria-label="Published contact details">
      <span className="support-eyebrow">PUBLISHED CONTACT DETAILS</span>
      {branding.contactEmail && <p><a className="support-header-link" href={`mailto:${branding.contactEmail}`}>{branding.contactEmail}</a></p>}
      {branding.contactPhone && <p><a className="support-header-link" href={`tel:${branding.contactPhone.replace(/[^\d+]/g, '')}`}>{branding.contactPhone}</a></p>}
      {branding.contactAddress && <p>{branding.contactAddress}</p>}
      {whatsappUrl && <p><a className="support-header-link" href={whatsappUrl} target="_blank" rel="noreferrer">WhatsApp contact</a></p>}
    </section>}
    <footer className="support-public-footer"><span>For your security, never send passwords, authentication codes, or payment credentials.</span><a href={import.meta.env.BASE_URL} aria-label={`Powered by ${branding.platformName} — visit homepage`}>Powered by {branding.platformName}</a></footer>
  </main>;
}

export default ContactPage;