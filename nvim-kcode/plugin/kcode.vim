" kcode.vim — Auto-load commands for nvim-kcode
" ────────────────────────────────────────────────────────────────────
" These commands are available before setup() is called, providing
" a fallback that auto-initializes with defaults.

if exists('g:loaded_kcode')
  finish
endif
let g:loaded_kcode = 1

" Ensure setup runs with defaults if the user hasn't called it explicitly.
function! s:ensure_setup() abort
  lua << EOF
  if not _G._kcode_initialized then
    _G._kcode_initialized = true
    require("kcode").setup()
  end
EOF
endfunction

command! -nargs=* KCode      call s:ensure_setup() | lua require("kcode.chat").send(<q-args> ~= "" and <q-args> or nil) or require("kcode.chat").toggle()
command! -nargs=* KCodeChat   call s:ensure_setup() | lua if <q-args> ~= "" then require("kcode.chat").send(<q-args>) else require("kcode.chat").open() end
command! -range   KCodeExplain call s:ensure_setup() | lua require("kcode.actions").explain_selection()
command! -range   KCodeFix     call s:ensure_setup() | lua require("kcode.actions").fix_selection()
command! -range   KCodeReview  call s:ensure_setup() | lua require("kcode.actions").review_selection()
command! -range   KCodeTests   call s:ensure_setup() | lua require("kcode.actions").generate_tests()
command!          KCodeHealth  call s:ensure_setup() | lua require("kcode.chat").health_check()
