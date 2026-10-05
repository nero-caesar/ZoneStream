import "server-only";

type Template = {
  toEmail: string;
  appName: string;
  resetLink: string;
};

export async function sendEmailJsTemplate(template: Template) {
  const serviceId = process.env.EMAILJS_SERVICE_ID?.trim();
  const templateId = process.env.EMAILJS_TEMPLATE_ID?.trim();
  const publicKey = process.env.EMAILJS_PUBLIC_KEY?.trim();
  const privateKey = process.env.EMAILJS_PRIVATE_KEY?.trim();
  if (!serviceId || !templateId || !publicKey || !privateKey) {
    throw new Error("Studio email delivery is not configured. Add the EmailJS service, template, public key, and private key to the local environment first.");
  }

  let response: Response;
  try {
    response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: {
          to_email: template.toEmail,
          app_name: template.appName,
          reset_link: template.resetLink,
        },
      }),
    });
  } catch {
    throw new Error("EmailJS could not reach its mail service. Check the connection and try again.");
  }
  if (!response.ok) throw new Error("EmailJS could not send the studio reset link. Check the service and template settings, then retry.");
}
