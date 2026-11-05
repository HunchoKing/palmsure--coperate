// Netlify version of api/send-email.js (the Vercel function): same emails, same recipients.
import { Resend } from 'resend';

export const config = { path: '/api/send-email' };

// Form text goes into HTML email, so escape it.
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json({ message: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ message: 'Invalid request' }, 400);
  }
  const { type, data } = body || {};
  if (!data || (type !== 'contact' && type !== 'quote')) return json({ message: 'Invalid request' }, 400);

  const contactEmail = process.env.PALMSURE_CONTACT_EMAIL || 'info@palmshore.co.za';
  const adminEmail = process.env.PALMSURE_ADMIN_EMAIL || process.env.PALMSURE_ADMIN_EMAI || 'roy@palmshore.co.za';

  let subject = '';
  let html = '';
  let replyTo = '';

  if (type === 'contact') {
    subject = `New Web Inquiry: ${String(data.fullName ?? '').replace(/[\r\n]+/g, ' ')}`;
    replyTo = data.email;
    html = `
      <h2>New Contact Message</h2>
      <p><strong>Name:</strong> ${esc(data.fullName)}</p>
      <p><strong>Email:</strong> ${esc(data.email)}</p>
      <p><strong>Phone:</strong> ${esc(data.contactNumber)}</p>
      <p><strong>Message:</strong></p>
      <blockquote style="background: #f9f9f9; padding: 10px; white-space: pre-wrap;">${esc(data.message)}</blockquote>
    `;
  } else {
    const p = data.personal || {};
    const d = data.details || {};
    subject = `New Quote Request (${data.type}) - ${p.firstName} ${p.lastName}`.replace(/[\r\n]+/g, ' ');
    replyTo = p.email;
    let specific = '';
    if (data.type === 'property') {
      specific = `<p><strong>Address:</strong> ${esc(d.propertyAddress)}</p><p><strong>Value:</strong> R${esc(d.propertyValue)}</p>`;
    } else if (data.type === 'vehicle') {
      specific = `<p><strong>Vehicle:</strong> ${esc(d.vehicleYear)} ${esc(d.vehicleMake)} ${esc(d.vehicleModel)}</p>`;
    } else if (data.type === 'business') {
      specific = `<p><strong>Business:</strong> ${esc(d.businessName)}</p><p><strong>Industry:</strong> ${esc(d.industry)}</p>`;
    }
    html = `
      <h2>New Quote Request</h2>
      <p><strong>Name:</strong> ${esc(p.firstName)} ${esc(p.lastName)}</p>
      <p><strong>Email:</strong> ${esc(p.email)}</p>
      <p><strong>Phone:</strong> ${esc(p.phone)}</p>
      <hr>
      ${specific}
    `;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data: sent, error } = await resend.emails.send({
      from: 'Palmsure Website <info@palmsure.co.za>',
      to: [contactEmail, adminEmail],
      subject,
      html,
      replyTo,
    });
    if (error) {
      console.error('Resend Error:', error);
      return json({ error: error.message }, 500);
    }
    return json(sent);
  } catch (error) {
    console.error('Resend Error:', error);
    return json({ error: error.message }, 500);
  }
};
