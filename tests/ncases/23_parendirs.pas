program ParenDirs;
{ Turbo Pascal reads directives in paren-star brackets like those in
  braces: defines, conditionals (also mixed and nested with braces, and
  inside skipped branches), include files and switches }
(*$DEFINE FOO*)
var a: array[1..5] of integer;
    i: integer;
begin
(*$IFDEF FOO*)
  WriteLn('FOO ON');
(*$ELSE*)
  WriteLn('FOO OFF');
(*$ENDIF*)
  (*$IFNDEF BAR*) WriteLn('NO BAR'); (*$ENDIF*)
  (*$IFDEF BAR*) WriteLn('BAR'); (*$ELSE*) WriteLn('ELSE BAR'); (*$ENDIF*)
  {$IFDEF FOO} (*$IFDEF BAR*) WriteLn('X'); (*$ENDIF*) WriteLn('MIXED'); {$ENDIF}
  (*$IFDEF BAR*) (* skipped *) {$IFDEF FOO} WriteLn('NO'); {$ELSE} WriteLn('NO'); {$ENDIF} (*$ELSE*) WriteLn('NESTED SKIP'); (*$ENDIF*)
  (*$IFDEF MERIDIAN*) WriteLn('MERIDIAN'); (*$ENDIF*)
(*$UNDEF FOO*)
  (*$IFDEF FOO*) WriteLn('STILL'); (*$ENDIF*)
(*$I PDINC*)
  for i := 1 to 5 do a[i] := i;
(*$R-*)
  i := 6; WriteLn('OFF ', a[i - 1]);
(*$R+*)
  i := 0;
  a[i] := 1;
  WriteLn('NOT REACHED');
end.

(* EXPECT
FOO ON
NO BAR
ELSE BAR
MIXED
NESTED SKIP
MERIDIAN
INCLUDED 42
OFF 5

RUNTIME ERROR 201
*)

(* FILE PDINC.PAS
  WriteLn('INCLUDED ', 6 * 7);
*)
