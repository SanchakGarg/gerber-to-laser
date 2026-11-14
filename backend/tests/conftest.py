"""Tiny synthetic board: 10 x 10 mm square at (100, 100), one trace, one pad, a region
with a clear-polarity hole, and one drill."""
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

HEADER = "%FSLAX46Y46*%\n%MOMM*%\n"


def c(v):
    return str(int(round(v * 1e6)))


def xy(x, y):
    return f"X{c(x)}Y{c(y)}"


def outline_gbr():
    pts = [(100, 100), (110, 100), (110, 110), (100, 110), (100, 100)]
    body = [f"{xy(*pts[0])}D02*"] + [f"{xy(*p)}D01*" for p in pts[1:]]
    return (HEADER + "%TF.FileFunction,Profile,NP*%\n%ADD10C,0.100000*%\nG01*\nD10*\n"
            + "\n".join(body) + "\nM02*\n")


def copper_gbr(side="Top"):
    return (HEADER + f"%TF.FileFunction,Copper,L1,{side}*%\n"
            "%ADD10C,1.000000*%\n%ADD11R,2.000000X2.000000*%\n%ADD12C,0.500000*%\nG01*\n"
            # trace (102,105)-(108,105) w=1
            f"D10*\n{xy(102, 105)}D02*\n{xy(108, 105)}D01*\n"
            # 2x2 pad at (105,108)
            f"D11*\n{xy(105, 108)}D03*\n"
            # 1x1 region at (101.5..102.5, 101.5..102.5)
            f"G36*\n{xy(101.5, 101.5)}D02*\n{xy(102.5, 101.5)}D01*\n{xy(102.5, 102.5)}D01*\n"
            f"{xy(101.5, 102.5)}D01*\n{xy(101.5, 101.5)}D01*\nG37*\n"
            # clear a 0.5 mm dot out of the trace
            f"%LPC*%\nD12*\n{xy(105, 105)}D03*\n%LPD*%\nM02*\n")


def mask_gbr(side="Top"):
    return (HEADER + f"%TF.FileFunction,Soldermask,{side}*%\n%ADD11R,2.200000X2.200000*%\n"
            f"D11*\n{xy(105, 108)}D03*\nM02*\n")


def silk_gbr(side="Top"):
    return (HEADER + f"%TF.FileFunction,Legend,{side}*%\n%ADD10C,0.200000*%\nG01*\n"
            f"D10*\n{xy(101, 109)}D02*\n{xy(104, 109)}D01*\nM02*\n")


def drill_drl():
    return ("M48\nMETRIC,TZ\nT1C0.800\n%\nG90\nG05\nT1\nX105.0Y102.0\nM30\n")


@pytest.fixture
def board_dir():
    d = Path(tempfile.mkdtemp())
    (d / "test-Edge_Cuts.gm1").write_text(outline_gbr())
    (d / "test-F_Cu.gtl").write_text(copper_gbr("Top"))
    (d / "test-F_Mask.gts").write_text(mask_gbr("Top"))
    (d / "test-F_Silkscreen.gto").write_text(silk_gbr("Top"))
    (d / "test-B_Cu.gbl").write_text(copper_gbr("Bot"))
    (d / "test.drl").write_text(drill_drl())
    (d / "test-job.gbrjob").write_text("{}")
    return d


@pytest.fixture
def board(board_dir):
    from app.board import Board
    return Board.from_paths(list(board_dir.iterdir()), Path(tempfile.mkdtemp()))
