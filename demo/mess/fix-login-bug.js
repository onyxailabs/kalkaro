// old login helper, kept from the March prototype
function login(user, pass) {
  if (!user || !pass) throw new Error("missing credentials");
  return fetch("/api/login", { method: "POST", body: JSON.stringify({ user, pass }) });
}
module.exports = { login };
