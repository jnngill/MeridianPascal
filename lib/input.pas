{ MERIDIAN Pascal - Input unit (PFORTE)
  Joysticks, keys held down (for games), mouse and the clock. }
unit Input;

interface

const
  { joystick bits }
  joyRight = 1; joyLeft = 2; joyDown = 4; joyUp = 8;
  joyFireA = 16; joyFireB = 32; joyFireC = 64; joyFireD = 128;
  joyStart = 256; joySelect = 512;

  { keys for KeyDown: PS/2 scan codes, the cursor keys etc. + 128 }
  scA = $1C; scB = $32; scC = $21; scD = $23; scE = $24; scF = $2B; scG = $34;
  scH = $33; scI = $43; scJ = $3B; scK = $42; scL = $4B; scM = $3A; scN = $31;
  scO = $44; scP = $4D; scQ = $15; scR = $2D; scS = $1B; scT = $2C; scU = $3C;
  scV = $2A; scW = $1D; scX = $22; scY = $35; scZ = $1A;
  sc0 = $45; sc1 = $16; sc2 = $1E; sc3 = $26; sc4 = $25; sc5 = $2E; sc6 = $36;
  sc7 = $3D; sc8 = $3E; sc9 = $46;
  scSpace = $29; scEnter = $5A; scEsc = $76; scBackspace = $66; scTab = $0D;
  scShift = $12; scRShift = $59; scCtrl = $14; scAlt = $11;
  scUp = $F5; scDown = $F2; scLeft = $EB; scRight = $F4;

function  Joy(n: integer): word;
function  JoyPressed(n: integer; bits: word): boolean;
function  KeyDown(scan: integer): boolean;
function  AnyKeyDown: boolean;
function  MouseX: integer;
function  MouseY: integer;
function  MouseButtons: byte;
function  MouseWheel: integer;
procedure SetMouse(x, y: integer);
procedure SetMouseLimits(maxX, maxY: integer);
function  Micros: longint;
procedure GetTime(var hour, min, sec: integer);
procedure GetDate(var year, month, day, weekday: integer);

implementation

function Joy(n: integer): word;
begin
  if n = 2 then Joy := MemW[$C10A] and $3FF
  else Joy := MemW[$C108] and $3FF;
end;

function JoyPressed(n: integer; bits: word): boolean;
begin
  JoyPressed := (Joy(n) and bits) <> 0;
end;

function KeyDown(scan: integer): boolean;
begin
  KeyDown := Mem[$033E00 + (scan and 255)] <> 0;
end;

function AnyKeyDown: boolean;
var i: integer;
begin
  AnyKeyDown := false;
  for i := 0 to 255 do
    if Mem[$033E00 + i] <> 0 then begin AnyKeyDown := true; exit; end;
end;

{ PFORTE gives the mouse state as it was at the last write to MAUS_FEST
  ($C12A), so every read takes a fresh one first }
function MouseX: integer;
begin
  Mem[$C12A] := 0;
  MouseX := MemW[$C120];
end;

function MouseY: integer;
begin
  Mem[$C12A] := 0;
  MouseY := MemW[$C122];
end;

function MouseButtons: byte;
begin
  Mem[$C12A] := 0;
  MouseButtons := Mem[$C124];
end;

function MouseWheel: integer;
begin
  Mem[$C12A] := 0;
  MouseWheel := shortint(Mem[$C125]);
end;

procedure SetMouse(x, y: integer);
begin
  MemW[$C120] := x;
  MemW[$C122] := y;
end;

procedure SetMouseLimits(maxX, maxY: integer);
begin
  MemW[$C126] := maxX;
  MemW[$C128] := maxY;
end;

function Micros: longint;
begin
  Mem[$C110] := 0;
  Micros := MemL[$C110];
end;

function Bcd(b: byte): integer;
begin
  Bcd := (b shr 4) * 10 + (b and 15);
end;

procedure GetTime(var hour, min, sec: integer);
begin
  Mem[$C137] := 0;              { freeze the clock for reading }
  sec := Bcd(Mem[$C130]);
  min := Bcd(Mem[$C131]);
  hour := Bcd(Mem[$C132]);
end;

procedure GetDate(var year, month, day, weekday: integer);
begin
  Mem[$C137] := 0;
  day := Bcd(Mem[$C133]);
  month := Bcd(Mem[$C134]);
  year := 2000 + Bcd(Mem[$C135]);
  weekday := Mem[$C136];
end;

end.
