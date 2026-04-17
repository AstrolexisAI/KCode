# Negative fixture for rb-001-eval.
# eval / send with a hardcoded allow-list or a constant expression
# has no injection surface.

ALLOWED = %w[add remove list].freeze

def dispatch(obj, action)
  return unless ALLOWED.include?(action)
  obj.public_send(action.to_sym)
end
