#!/bin/bash
# ─── build-wasm-grep.sh ─────────────────────────────────────────
# Build a real grep (busybox's grep applet — the standard POSIX
# implementation used on embedded Linux) into a wasm32-wasi binary
# that the browser shell runs as a native command.
#
# Pipeline:
#   1. Clone busybox (or reuse an existing clone in build/grep-wasm/)
#   2. make allnoconfig, enable just CONFIG_GREP + CONFIG_LFS,
#      disable the ash shell (wasm has no fork/exec)
#   3. Compile with the wasi-sdk (wasm32-wasi-clang). Busybox's
#      libbb pulls in a lot of POSIX API that wasi-libc hides behind
#      __wasilibc_unmodified_upstream (chown, mknod, sigaction, ...)
#      — we provide compile-time declarations in build/grep-wasm/stubs/
#      and link the wasi emulated-* libraries for the pieces grep
#      actually uses. x86-only assembly hashes and the network
#      helpers (herror_msg, inet_common, xconnect) are dropped from
#      libbb/Kbuild.src — grep doesn't need them.
#   4. Link with -Wl,--undefined=__main_argc_argv: wasm-ld's
#      --gc-sections otherwise collects the real main() (wasi-libc
#      only references it weakly through __main_void).
#   5. Drop the result in www/wasm-bin/grep.wasm
#
# Usage:
#   ./build-wasm-grep.sh
#   WASI_SDK=/opt/wasi-sdk-25.0-x86_64-linux ./build-wasm-grep.sh
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK/bin/clang"
AR="$WASI_SDK/bin/llvm-ar"
NM="$WASI_SDK/bin/llvm-nm"
RANLIB="$WASI_SDK/bin/llvm-ranlib"
STRIP="$WASI_SDK/bin/llvm-strip"

# 1. Working directories
BUILD="$REPO/build/grep-wasm"
TC="$BUILD/toolchain"
STUBS="$BUILD/stubs"
BB_DIR="$BUILD/busybox"
mkdir -p "$TC" "$STUBS"

# Toolchain symlinks — busybox expects $(CROSS_COMPILE)gcc, ar, nm, strip...
ln -sf "$CLANG" "$TC/wasm32-wasi-gcc"
ln -sf "$CLANG" "$TC/wasm32-wasi-cc"
ln -sf "$AR" "$TC/wasm32-wasi-ar"
ln -sf "$NM" "$TC/wasm32-wasi-nm"
ln -sf "$RANLIB" "$TC/wasm32-wasi-ranlib"
ln -sf "$STRIP" "$TC/wasm32-wasi-strip"
export CROSS_COMPILE="$TC/wasm32-wasi-"

# 2. Stub headers — POSIX APIs wasi-libc doesn't ship (declarations
# only; the final link only pulls in what grep really calls).
cat > "$STUBS/netdb.h" << 'EOF'
#ifndef _NETDB_H
#define _NETDB_H
#include <sys/socket.h>
#define NI_MAXHOST 1025
#define NI_MAXSERV 32
#define NI_NUMERICHOST 1
#define AI_PASSIVE 1
#define AI_CANONNAME 2
#define AI_NUMERICHOST 4
struct addrinfo { int ai_flags; int ai_family; int ai_socktype; int ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
struct hostent {
  char *h_name;
  char **h_aliases;
  int h_addrtype;
  int h_length;
  char **h_addr_list;
};
#define h_addr h_addr_list[0]
struct hostent *gethostbyname(const char *name);
struct hostent *gethostbyaddr(const void *addr, int len, int type);
int gethostname(char *name, size_t len);
int sethostent(int stayopen);
void endhostent(void);
struct hostent *gethostent(void);
#endif
EOF

cat > "$STUBS/setjmp.h" << 'EOF'
#ifndef _SETJMP_H
#define _SETJMP_H
/* Stub: nothing in the minimal busybox config uses setjmp/longjmp
 * (xfunc_die just exits). The wasi sysroot's real setjmp.h requires
 * the wasm exception-handling proposal, which @wasmer/wasi lacks. */
typedef struct { int __dummy; } jmp_buf[1];
typedef jmp_buf sigjmp_buf;
#define setjmp(env) 0
#define sigsetjmp(env, savemask) 0
#define longjmp(env, val) ((void)0)
#define siglongjmp(env, val) ((void)0)
#endif
EOF

cat > "$STUBS/paths.h" << 'EOF'
#ifndef _PATHS_H
#define _PATHS_H
#define _PATH_DEVNULL "/dev/null"
#define _PATH_TTY "/dev/tty"
#define _PATH_TMP "/tmp"
#endif
EOF

mkdir -p "$STUBS/sys" "$STUBS/net"

cat > "$STUBS/sys/sysmacros.h" << 'EOF'
#ifndef _SYS_SYSMACROS_H
#define _SYS_SYSMACROS_H
#define major(dev) ((int)(((dev) >> 8) & 0xfff))
#define minor(dev) ((int)(((dev) & 0xff) | (((dev) >> 12) & 0xfff00)))
#define makedev(maj, min) (((maj) & 0xfff) << 8 | ((min) & 0xff) | (((min) & 0xfff00) << 12))
#endif
EOF

cat > "$STUBS/sys/wait.h" << 'EOF'
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H
#define WNOHANG 1
#define WUNTRACED 2
#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WIFSIGNALED(s) (((s) & 0x7f) != 0 && ((s) & 0x7f) != 0x7f)
#define WTERMSIG(s) ((s) & 0x7f)
#define WIFSTOPPED(s) (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s) (((s) >> 8) & 0xff)
#endif
EOF

cat > "$STUBS/sys/statfs.h" << 'EOF'
#ifndef _SYS_STATFS_H
#define _SYS_STATFS_H
struct statfs {
  long f_type, f_bsize, f_blocks, f_bfree, f_bavail, f_files, f_ffree;
  int f_fsid, f_namelen, f_frsize, f_flags, f_spare[4];
};
static inline int statfs(const char *p, struct statfs *b) { (void)p; (void)b; return -1; }
static inline int fstatfs(int fd, struct statfs *b) { (void)fd; (void)b; return -1; }
#endif
EOF

cat > "$STUBS/sys/socket.h" << 'EOF'
#ifndef _STUB_SYS_SOCKET_H
#define _STUB_SYS_SOCKET_H
#include_next <sys/socket.h>
/* wasi-libc only defines these under __wasilibc_unmodified_upstream */
#ifndef SOCK_RAW
#define SOCK_RAW 3
#endif
#ifndef SOCK_RDM
#define SOCK_RDM 4
#endif
#ifndef SOCK_SEQPACKET
#define SOCK_SEQPACKET 5
#endif
#ifndef SOCK_PACKET
#define SOCK_PACKET 10
#endif
#endif
EOF

cat > "$STUBS/net/if.h" << 'EOF'
#ifndef _NET_IF_H
#define _NET_IF_H
#define IFNAMSIZ 16
struct ifreq {
  char ifr_name[IFNAMSIZ];
  union { struct sockaddr ifru_addr; int ifru_flags; } ifr_ifru;
};
#define ifr_addr ifr_ifru.ifru_addr
#define ifr_flags ifr_ifru.ifru_flags
#endif
EOF

cat > "$STUBS/mntent.h" << 'EOF'
#ifndef _MNTENT_H
#define _MNTENT_H
#include <stdio.h>
struct mntent {
  char *mnt_fsname;
  char *mnt_dir;
  char *mnt_type;
  char *mnt_opts;
  int mnt_freq;
  int mnt_passno;
};
FILE *setmntent(const char *file, const char *mode);
struct mntent *getmntent(FILE *stream);
int addmntent(FILE *stream, const struct mntent *mnt);
int endmntent(FILE *stream);
char *hasmntopt(const struct mntent *mnt, const char *opt);
#endif
EOF

cat > "$STUBS/pwd.h" << 'EOF'
#ifndef _PWD_H
#define _PWD_H
#include <sys/types.h>
struct passwd {
  char *pw_name;
  char *pw_passwd;
  uid_t pw_uid;
  gid_t pw_gid;
  char *pw_gecos;
  char *pw_dir;
  char *pw_shell;
};
struct passwd *getpwuid(uid_t uid);
struct passwd *getpwnam(const char *name);
int getpwuid_r(uid_t uid, struct passwd *p, char *buf, size_t n, struct passwd **r);
int getpwnam_r(const char *name, struct passwd *p, char *buf, size_t n, struct passwd **r);
#endif
EOF

cat > "$STUBS/grp.h" << 'EOF'
#ifndef _GRP_H
#define _GRP_H
#include <sys/types.h>
struct group {
  char *gr_name;
  char *gr_passwd;
  gid_t gr_gid;
  char **gr_mem;
};
struct group *getgrgid(gid_t gid);
struct group *getgrnam(const char *name);
int getgrgid_r(gid_t gid, struct group *g, char *buf, size_t n, struct group **r);
int getgrnam_r(const char *name, struct group *g, char *buf, size_t n, struct group **r);
#endif
EOF

cat > "$STUBS/sched.h" << 'EOF'
#ifndef _SCHED_H
#define _SCHED_H
#include <sys/types.h>
struct sched_param { int sched_priority; };
int sched_get_priority_max(int policy);
int sched_get_priority_min(int policy);
int sched_yield(void);
int sched_getaffinity(pid_t pid, size_t cpusetsize, unsigned long *mask);
#endif
EOF

cat > "$STUBS/termios.h" << 'EOF'
#ifndef _TERMIOS_H
#define _TERMIOS_H
typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
typedef unsigned int speed_t;
#define NCCS 32
#define ICANON 0x0002
#define ECHO 0x0008
#define ISIG 0x0001
#define ECHOE 0x0010
#define ECHOK 0x0020
#define ECHONL 0x0040
#define ICRNL 0x0100
#define IEXTEN 0x8000
#define OPOST 0x0001
#define ONLCR 0x0002
#define TCSANOW 0
#define TCSADRAIN 1
#define TCSAFLUSH 2
#define TCIFLUSH 0
#define TCOFLUSH 1
#define TCIOFLUSH 2
#define CLOCAL 0x800
#define CREAD 0x80
#define CS8 0x30
#define CSTOPB 0x40
#define PARENB 0x100
#define PARODD 0x200
#define HUPCL 0x400
#define IXON 0x400
#define BRKINT 0x2
#define IGNBRK 0x1
#define IGNCR 0x80
#define INLCR 0x40
#define ISTRIP 0x20
#define IXOFF 0x1000
#define OLCUC 0x2
#define OCRNL 0x8
#define OXTABS 0x4000
#define TAB3 0x4000
#define TOSTOP 0x100
#define VDISCARD 13
#define VEOF 4
#define VEOL 11
#define VERASE 2
#define VINTR 0
#define VKILL 3
#define VQUIT 1
#define VSTART 8
#define VSTOP 9
#define VSUSP 10
#define VWERASE 14
struct termios {
  tcflag_t c_iflag, c_oflag, c_cflag, c_lflag;
  cc_t c_line;
  cc_t c_cc[NCCS];
  speed_t c_ispeed, c_ospeed;
};
#ifndef B0
#define B0 0
#endif
#define B50 1
#define B75 2
#define B110 3
#define B134 4
#define B150 5
#define B200 6
#define B300 7
#define B600 8
#define B1200 9
#define B1800 10
#define B2400 11
#define B4800 12
#define B9600 13
#define B19200 14
#define B38400 15
#define B57600 4097
#define B115200 4098
#ifndef VMIN
#define VMIN 6
#endif
#ifndef VTIME
#define VTIME 5
#endif
static inline int tcgetattr(int fd, struct termios *t) { (void)fd; (void)t; return -1; }
static inline int tcsetattr(int fd, int a, const struct termios *t) { (void)fd; (void)a; (void)t; return -1; }
static inline int tcflush(int fd, int q) { (void)fd; (void)q; return -1; }
static inline speed_t cfgetospeed(const struct termios *t) { (void)t; return B0; }
static inline int cfsetospeed(struct termios *t, speed_t s) { (void)t; (void)s; return 0; }
static inline int cfsetispeed(struct termios *t, speed_t s) { (void)t; (void)s; return 0; }
static inline void cfmakeraw(struct termios *t) { (void)t; }
static inline int tcdrain(int fd) { (void)fd; return 0; }
static inline int tcsendbreak(int fd, int d) { (void)fd; (void)d; return -1; }
#endif
EOF

# Force-included into every TU: declarations for the remaining POSIX
# API wasi-libc hides behind __wasilibc_unmodified_upstream (which we
# don't enable wholesale — it changes header structure and breaks
# bits/errno.h).
cat > "$STUBS/wasi_compat.h" << 'EOF'
#ifndef _WASI_COMPAT_H
#define _WASI_COMPAT_H
#include <sys/types.h>
#include <sys/resource.h>
#include <signal.h>
#include <sched.h>
int mknod(const char *, mode_t, dev_t);
int mknodat(int, const char *, mode_t, dev_t);
int chown(const char *, uid_t, gid_t);
int fchown(int, uid_t, gid_t);
int lchown(const char *, uid_t, gid_t);
int fchownat(int, const char *, uid_t, gid_t, int);
struct sigaction {
  union {
    void (*sa_handler)(int);
    void (*sa_sigaction)(int, void *, void *);
  } __sa_handler;
  unsigned long sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction
int sigaction(int, const struct sigaction *__restrict, struct sigaction *__restrict);
unsigned alarm(unsigned);
int getgroups(int, gid_t *);
uid_t geteuid(void);
gid_t getegid(void);
uid_t getuid(void);
gid_t getgid(void);
int initgroups(const char *, gid_t);
int endgrent(void);
int endpwent(void);
mode_t umask(mode_t);
int execvp(const char *, char *const []);
int execv(const char *, char *const []);
extern int h_errno;
const char *hstrerror(int);
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#define SIG_DFL ((void (*)(int))0)
#define SIG_IGN ((void (*)(int))1)
#define SIG_ERR ((void (*)(int))-1)
int sigfillset(unsigned long *set);
int sigemptyset(unsigned long *set);
int sigaddset(unsigned long *set, int signo);
int sigprocmask(int how, const unsigned long *set, unsigned long *oldset);
int kill(pid_t pid, int sig);
#define SA_RESTART 0x10000000
int sigsuspend(const unsigned long *set);
int vfork(void);
int dup(int);
int dup2(int, int);
int setsid(void);
int setpgid(pid_t, pid_t);
int getpid(void);
int getppid(void);
int fork(void);
struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#endif
pid_t waitpid(pid_t, int *, int);
int pipe(int[2]);
int mkstemp(char *);
int setgid(gid_t);
int setuid(uid_t);
int setegid(gid_t);
int seteuid(uid_t);
int fchdir(int);
int chroot(const char *);
int getsockname(int, struct sockaddr *__restrict, unsigned *__restrict);
int socket(int, int, int);
int bind(int, const struct sockaddr *, unsigned);
int listen(int, int);
ssize_t sendto(int, const void *, size_t, int, const struct sockaddr *, unsigned);
int ttyname_r(int, char *, size_t);
int settimeofday(const void *, const void *);
#endif
EOF

CFLAGS="-I$STUBS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -include wasi_compat.h"
LDFLAGS="-Wl,--undefined=main -Wl,--undefined=__main_argc_argv"

# 3. Busybox source
UPSTREAM="https://github.com/gmatht/busybox.git"  # our fork of busybox (GPL-2.0); build config lives in this script
if [[ ! -d "$BB_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BB_DIR")"
  echo "Cloning busybox from $UPSTREAM ..."
  git clone --depth 1 "$UPSTREAM" "$BB_DIR"
fi
echo "Using busybox checkout: $BB_DIR"
cd "$BB_DIR"

# 4. Minimal config: grep only (no shell — wasm has no fork/exec)
make allnoconfig
sed -i 's/# CONFIG_GREP is not set/CONFIG_GREP=y/; s/# CONFIG_LFS is not set/CONFIG_LFS=y/' .config
# Fill in defaults for the remaining options (accept every default)
make oldconfig </dev/null >/dev/null
# oldconfig defaults the shell to ash; disable it (needs fork/exec)
sed -i 's/^CONFIG_SHELL_ASH=y/# CONFIG_SHELL_ASH is not set/;
        s/^CONFIG_SH_IS_ASH=y/# CONFIG_SH_IS_ASH is not set/;
        s/^# CONFIG_SH_IS_NONE is not set/CONFIG_SH_IS_NONE=y/;
        s/^CONFIG_ASH=y/# CONFIG_ASH is not set/' .config
sed -i 's/^CONFIG_EXTRA_LDLIBS=""/CONFIG_EXTRA_LDLIBS="-lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks"/' .config

# 5. Drop x86-only assembly hashes and the network helpers from libbb
# (grep doesn't need them; the .S files don't assemble for wasm and
# the network files need a full socket API wasi doesn't have).
sed -i '/^lib-y += hash_sha1_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha1_hwaccel_x86-32.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-64.o$/d;
        /^lib-y += hash_sha256_hwaccel_x86-32.o$/d;
        /^lib-y += herror_msg.o$/d;
        /^lib-y += inet_common.o$/d;
        /^lib-y += xconnect.o$/d' libbb/Kbuild.src

# 6. Build (parallel — busybox's own rules are fine with -j)
echo "== Building busybox grep for wasm32-wasi =="
make busybox -j"$(nproc)" \
  EXTRA_CFLAGS="$CFLAGS" \
  EXTRA_LDFLAGS="$LDFLAGS" >/dev/null

# 7. Install into the shell's wasm-bin
DEST="$REPO/www/wasm-bin/grep.wasm"
mkdir -p "$(dirname "$DEST")"
cp busybox "$DEST"
echo ""
echo "✓ Built and installed: $DEST ($(du -h "$DEST" | cut -f1))"
echo "  In the shell:  wasmer install grep  →  echo \"hello\" | grep hello"
