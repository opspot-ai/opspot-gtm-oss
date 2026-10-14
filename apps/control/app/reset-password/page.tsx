import { ResetPasswordForm } from "./reset-password-form";

export default function ResetPasswordPage() {
  return <main className="auth-shell"><section className="auth-card" aria-labelledby="reset-title">
    <a className="auth-brand" href="/">OpSpot <span>GTM Cloud</span></a>
    <p className="eyebrow">Account recovery</p>
    <h1 id="reset-title">Set a new password</h1>
    <p>Choose a new password for this account.</p>
    <ResetPasswordForm />
  </section></main>;
}
