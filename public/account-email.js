// Opening an email link never consumes it. Confirmation requires an explicit POST.
export function readEmailAction(location = window.location, history = window.history) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("email-action")) return null;
  const action = { purpose: params.get("email-action"), token: params.get("token") || "" };
  history.replaceState(null, "", location.pathname + location.search);
  return action;
}
export function mountAccountEmail({ api, toast, showScreen, showLogin, getUser, updateUser, getSessionRevision = () => 0, verificationRequired = () => true, accountEmailsEnabled = () => true }) {
  const qs = selector => document.querySelector(selector);
  let action = readEmailAction();
  let resendAfter = 0, timer, renderedSession = "";
  const identity = () => ({ id: getUser()?.id, revision: getSessionRevision() });
  const sameSession = before => before.id === getUser()?.id && before.revision === getSessionRevision();
  const status = message => { qs("#emailActionFeedback").textContent = message; };
  function openAction() {
    if (!action) return;
    showScreen("email"); qs("#emailActionForm").hidden = false; qs("#emailActionForm").reset();
    const reset = action.purpose === "reset", valid = ["verify", "reset"].includes(action.purpose) && /^[\w-]+\.[\w-]{43}$/.test(action.token);
    qs("#emailActionTitle").textContent = reset ? "Choose a new password" : "Verify your email";
    qs("#emailActionDescription").textContent = reset ? "Use at least 12 characters. A few memorable words work well." : "Confirm your email address to place orders and receive account updates.";
    qs("#emailActionPasswords").hidden = !reset; qs("#emailActionPasswords").disabled = !reset;
    qs("#emailActionSubmit").textContent = reset ? "Update password" : "Verify email";
    qs("#emailActionSubmit").disabled = !valid;
    status(valid ? "" : "This link is not valid. Request a new email and try again.");
  }
  function render() {
    const user = getUser(), banner = qs("#emailVerificationBanner");
    const sessionKey = `${getSessionRevision()}:${user?.id || ""}`;
    if (renderedSession !== sessionKey) {
      renderedSession = sessionKey; resendAfter = 0; clearTimeout(timer);
      document.querySelectorAll("[data-refresh-verification]").forEach(button => { button.disabled = false; });
    }
    if (!banner) return; banner.hidden = !user || user.emailVerified || !accountEmailsEnabled();
    banner.querySelector("strong").textContent = verificationRequired() ? "Verify your email to place orders" : "Verify your email address";
    banner.querySelector("p").textContent = verificationRequired() ? "You can browse and save your basket while you check your inbox." : "Confirm your address for account recovery and important updates.";
    document.querySelectorAll("[data-resend-verification]").forEach(button => {
      button.disabled = Date.now() < resendAfter; button.textContent = button.disabled ? "Email requested" : "Resend verification";
    });
  }
  document.addEventListener("click", async event => {
    if (event.target.closest("#showForgotPassword")) {
      qs("#forgotPasswordForm").reset(); qs("#forgotPasswordFeedback").textContent = "";
      showScreen("forgot"); qs('#forgotPasswordForm input').focus();
    }
    if (event.target.closest("[data-email-back-login]")) showLogin();
    if (event.target.closest("[data-correct-email]") && getUser() && !getUser().emailVerified) {
      qs('#correctEmailForm button[type="submit"]').disabled = false;
      qs("#correctEmailForm").reset(); qs('#correctEmailForm input[name="email"]').value = getUser().email;
      qs("#correctEmailFeedback").textContent = ""; qs("#correctEmailDialog").showModal();
    }
    if (event.target.closest("[data-close-correct-email]")) qs("#correctEmailDialog").close();
    const button = event.target.closest("[data-resend-verification]");
    if (button && !button.disabled && Date.now() >= resendAfter) {
      const session = identity();
      button.disabled = true;
      try {
        const result = await api("/api/account/email/verification", { method: "POST", body: "{}" }); if (!sameSession(session)) return; toast(result.message);
        resendAfter = Date.now() + 60000; clearTimeout(timer); timer = setTimeout(render, 60000);
      } catch (error) { if (sameSession(session)) toast(error.message); }
      render();
    }
    const refresh = event.target.closest("[data-refresh-verification]");
    if (refresh && !refresh.disabled) {
      const session = identity();
      refresh.disabled = true;
      try {
        const result = await api("/api/auth/me");
        if (!sameSession(session)) return;
        if (!result.user) { showLogin(); return; }
        updateUser(result.user); render(); toast(result.user.emailVerified ? "Your email address is verified." : "Verification is still pending. Open the link in your email first.");
      } catch (error) { if (sameSession(session)) toast(error.message); }
      finally { if (sameSession(session)) refresh.disabled = false; }
    }
  });
  qs("#forgotPasswordForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector('button[type="submit"]');
    if (button.disabled) return; button.disabled = true;
    try {
      const result = await api("/api/auth/password/request", { method: "POST", body: JSON.stringify({ email: new FormData(form).get("email") }) });
      qs("#forgotPasswordFeedback").textContent = result.message; form.reset();
    } catch (error) { qs("#forgotPasswordFeedback").textContent = error.message; }
    finally { button.disabled = false; }
  });
  qs("#emailActionForm").addEventListener("submit", async event => {
    event.preventDefault(); const button = qs("#emailActionSubmit");
    if (button.disabled || !action) return; button.disabled = true;
    const values = new FormData(event.target);
    const submittedAction = action;
    if (action.purpose === "reset" && values.get("password") !== values.get("confirmPassword")) { status("Passwords must match."); button.disabled = false; return; }
    try {
      const result = await api(action.purpose === "reset" ? "/api/auth/password/reset" : "/api/auth/email/confirm", { method: "POST", body: JSON.stringify({ token: action.token, password: values.get("password"), confirmPassword: values.get("confirmPassword") }) });
      if (action !== submittedAction) return;
      action.token = ""; qs("#emailActionForm").reset(); qs("#emailActionForm").hidden = true;
      qs("#emailActionDescription").textContent = result.message; status("");
    } catch (error) { if (action === submittedAction) { status(error.message); button.disabled = false; } }
  });
  qs("#correctEmailForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, button = form.querySelector('button[type="submit"]');
    if (button.disabled) return; button.disabled = true;
    const values = new FormData(form);
    const session = identity();
    try {
      const result = await api("/api/account/email", { method: "POST", body: JSON.stringify({ email: values.get("email"), password: values.get("password") }) });
      if (!getUser() || !sameSession(session)) return;
      updateUser(result.user); resendAfter = Date.now() + 60000; clearTimeout(timer); timer = setTimeout(render, 60000);
      render(); qs("#correctEmailDialog").close(); toast(result.message);
    } catch (error) { if (sameSession(session)) qs("#correctEmailFeedback").textContent = error.message; }
    finally { if (sameSession(session)) { form.querySelector('[name="password"]').value = ""; button.disabled = false; } }
  });
  qs("#correctEmailDialog").addEventListener("close", () => { qs("#correctEmailForm").reset(); });
  window.addEventListener("hashchange", () => {
    const next = readEmailAction(); if (!next) return;
    action = next; showLogin(); openAction();
  });
  return { openAction, render };
}
