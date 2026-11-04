$fn=32;
module base(){ difference(){ cube([60,60,10],center=true); for(x=[-2:2],y=[-2:2]) translate([x*10,y*10,0]) cylinder(r=3,h=30,center=true); } }
base();
translate([20*cos($t*360),20*sin($t*360),8]) sphere(4);
