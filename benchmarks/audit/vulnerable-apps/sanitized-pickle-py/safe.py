"""Negative fixture: no pickle, no eval, no SQL — pure list operations."""

def double_each(numbers):
    return [n * 2 for n in numbers]


def filter_positive(numbers):
    return [n for n in numbers if n > 0]


def total(numbers):
    return sum(numbers)
