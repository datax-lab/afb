import numpy as np
from multiprocessing import Pool

def score(tile):
    a = np.asarray(tile).reshape(-1, 3).transpose().astype(int)
    return np.count_nonzero(
        (((a[0]) - a[2]) > 10) & # more red than blue
        (((a[0]) - a[1]) > 30)   # more red than green
    )