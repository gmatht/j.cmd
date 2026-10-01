def first[T](xs: list[T]) -> T:
    return xs[0]


def pick[T: (int, str)](x: T) -> T:
    return x


class Box[T]:
    def __init__(self, v: T) -> None:
        self.v = v

    def get(self) -> T:
        return self.v


type IntList = list[int]
type Pairs[T] = list[tuple[T, T]]
type Alias = int


def total(xs: IntList) -> int:
    s = 0
    for x in xs:
        s += x
    return s


def head_of(p: Pairs[int]) -> int:
    return p[0][0]


def as_int(x: Alias) -> Alias:
    return x


print(first([10, 20]))
print(first(["a", "b"]))
print(pick(3), pick("s"))
print(Box(42).get())
print(total([1, 2, 3]))
print(head_of([(1, 2), (3, 4)]))
print(as_int(7))
