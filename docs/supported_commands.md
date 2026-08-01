# Supported commands

The full command surface of the shell, by category. Implementation
details (where each lives, engines, runnability) are in
[commands-inventory.md](commands-inventory.md).

## 1. Shell builtins — both shells, native JS (29)

```
bash  bash2js  cat  cd  chmod  chroot  cp  echo  exit  export  false
find  grep  head  help  ls  man  mkdir  mount  mv  pwd  rm  su  tail
true  unmount  wasmer  which  whoami
```

## 2. Browser-only builtins — www/index.html (13)

```
asciinema  browse  clear  edit  history  less  locate  more  play
resize  stty  vi  wat2wasm
```

## 3. /bin command scripts — seeded from src/fs/index.js (37 regular)

```
arecord  at  audiodemo  base32  base64  cmatrix  counter  cowsay  cron
curl  debashc  diff  figlet  fortune  gunzip  gzip  llm  lua  mail
md5sum  perl  sayhello  screen  sh2js  sh2perl  sha256sum  sl  tar
time  tree  uptime  watch  webgldemo  xclip  xeyes  xterm  zip
```

## 4. Site commands — generated from SITE_CMDS (8)

```
youtube  reddit  slashdot  lwn  hn  github  wikipedia  arxiv
```

## 5. wasm32-wasi binaries — www/wasm-bin/ (9)

```
compiler (cc)  debashcl  echo  echoc  grep  make*  python  sh2perl  wasm-diff†
```

`*` 39-byte stub, not built · `†` wasm-bindgen library, driven by /bin/diff.js

## 6. debashcl builtins — bash-context, toolchain-handled (34)

```
.  :  basename  break  cd  cmp  comm  command  continue  declare
dirname  echo  eval  exit  export  false  head  let  local  mapfile
printf  pwd  read  readarray  readonly  return  seq  set  shift  sleep
sort  source  stat  tail  touch  trap  true  type  typeset  uniq
unset  wait  wc
```

(9 of these — cd echo exit export false head pwd tail true — are also
shell builtins; the other 25 work only inside bash)

## 7. sh2.* runtime API — internal, not commands (29)

```
exec  pipeline  capture  captureWords  redirect  test  forLoop
whileLoop  caseMatch  define  brace  param  arith  guard  and  or
arithEval  setArray  setArrayAppend  arrayIndex  arrayLen  assign
break  continue  idiv  imod  not  setLastExit  getVar  setVar
```
