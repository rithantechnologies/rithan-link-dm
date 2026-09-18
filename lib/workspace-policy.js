function requireWorkspaceRole(...roles) {
  return (req, res, next) => {
    const role = String(req.auth?.role || "").toLowerCase();
    if (!roles.includes(role)) {
      return res.status(403).json({
        error: "workspace_role_required",
        allowedRoles: roles
      });
    }
    next();
  };
}

const requireWorkspaceEditor =
  requireWorkspaceRole("owner", "admin");

const requireWorkspaceOwner =
  requireWorkspaceRole("owner");

module.exports = {
  requireWorkspaceRole,
  requireWorkspaceEditor,
  requireWorkspaceOwner
};
