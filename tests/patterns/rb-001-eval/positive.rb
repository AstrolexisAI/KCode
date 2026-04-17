# Positive fixture for rb-001-eval.
# eval / send / instance_eval with params/request/input is RCE.
# The regex specifically matches when the first arg is one of
# those untrusted-source identifiers.

def run_formula(params)
  # CONFIRMED: params[:formula] is attacker-controlled.
  eval(params[:formula])
end

def dispatch(request, obj)
  # CONFIRMED: method name from request is RCE via send.
  obj.send(request[:method])
end
